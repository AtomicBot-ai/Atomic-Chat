"""
demo/main.py — Orchestrator CLI for the Atomic-Chat concurrent multi-agent demo.

Flow:
    1. Parse CLI flags and materialise the requested scenario.
    2. Call the orchestrator prompt once to turn a free-form topic into a list
       of per-agent task dicts (JSON).
    3. Fan-out N specialist agents with ``asyncio.gather``; every agent pushes
       progress events onto a shared queue that drives the Rich dashboard.
    4. Render a static HTML gallery of the results and (optionally) open it
       in the default browser.

Usage:
    bash run.sh --scenario svg --topic "Technology and AI" --tasks 8
"""

from __future__ import annotations

import asyncio
import json
import pathlib
import subprocess
import sys
import time
import webbrowser
from typing import Any

import httpx
import typer

from demo.client import ClientSettings, build_async_client, stream_chat
from demo.dashboard import DashboardState, run_dashboard
from demo.metrics import ServerMetrics, poll_metrics_loop
from demo.scenarios import get_scenario
from demo.templates import build_page

BUILD_DIR = pathlib.Path(__file__).resolve().parent.parent / "website_build"
PREVIEW_TAIL = 160

app = typer.Typer(add_completion=False, no_args_is_help=False)


async def _run_plan(
    client: httpx.AsyncClient,
    *,
    model: str,
    scenario: dict[str, Any],
    topic: str,
    n_agents: int,
) -> list[dict]:
    """Invoke the orchestrator agent to split the topic into per-agent tasks.

    Falls back to `direct_instruction` from the scenario agent definitions if
    the model produces invalid JSON — lets the demo still run on small models
    that occasionally mis-format structured output.
    """
    agents = scenario["agents"]
    plan = scenario["plan"]
    agent_list = ", ".join(a["name"] for a in agents)
    user_prompt = (
        plan["user"].replace("{topic}", topic).replace("{agent_list}", agent_list)
    )

    raw = ""
    async for chunk in stream_chat(
        client,
        model=model,
        system=plan["system"],
        user=user_prompt,
        max_tokens=max(1024, n_agents * 200),
    ):
        choices = chunk.get("choices") or []
        if not choices:
            continue
        delta = choices[0].get("delta") or {}
        content = delta.get("content") or ""
        if content:
            raw += content

    start = raw.find("[")
    end = raw.rfind("]")
    if start != -1 and end != -1:
        try:
            return json.loads(raw[start : end + 1])
        except json.JSONDecodeError:
            pass

    # Graceful degradation — fall back to per-agent canned instructions.
    return [
        {
            "name": agent["name"],
            "instruction": agent["direct_instruction"].replace("{topic}", topic),
        }
        for agent in agents
    ]


async def _run_agent(
    client: httpx.AsyncClient,
    *,
    model: str,
    agent: dict,
    task: dict,
    system_prompt: str,
    queue: asyncio.Queue,
) -> tuple[str, str, bool]:
    """Stream one specialist agent end-to-end, reporting progress to `queue`."""
    name = agent["name"]
    started = time.monotonic()
    tokens = 0
    content = ""
    server_tokens: int | None = None

    await queue.put({
        "name": name,
        "emoji": agent.get("emoji", "\U0001f916"),
        "color": agent.get("color", "1;37"),
        "status": "running",
        "tokens": 0,
        "tps": 0.0,
        "elapsed": 0.0,
        "preview": "",
    })

    try:
        async for chunk in stream_chat(
            client,
            model=model,
            system=system_prompt,
            user=task.get("instruction", ""),
            max_tokens=4000,
        ):
            usage = chunk.get("usage")
            if isinstance(usage, dict):
                server_tokens = usage.get("completion_tokens")
            choices = chunk.get("choices") or []
            if not choices:
                continue
            delta = choices[0].get("delta") or {}
            piece = delta.get("content") or ""
            if not piece:
                continue
            content += piece
            tokens += 1
            elapsed = time.monotonic() - started
            reported = server_tokens if server_tokens is not None else tokens
            tps = reported / elapsed if elapsed > 0 else 0.0
            await queue.put({
                "name": name,
                "status": "running",
                "tokens": reported,
                "tps": tps,
                "elapsed": elapsed,
                "preview": content[-PREVIEW_TAIL:],
            })
    except (httpx.HTTPError, OSError) as exc:
        elapsed = time.monotonic() - started
        await queue.put({
            "name": name,
            "status": "error",
            "elapsed": elapsed,
            "preview": f"[error] {exc}",
        })
        return name, "", False

    elapsed = time.monotonic() - started
    reported = server_tokens if server_tokens is not None else tokens
    tps = reported / elapsed if elapsed > 0 else 0.0
    await queue.put({
        "name": name,
        "status": "done",
        "tokens": reported,
        "tps": tps,
        "elapsed": elapsed,
        "preview": content[-PREVIEW_TAIL:],
    })
    return name, content, True


async def _run(
    *,
    scenario_name: str,
    topic: str,
    tasks: int | None,
    open_browser: bool,
) -> int:
    settings = ClientSettings.from_env()
    scenario = get_scenario(scenario_name, n_agents=tasks)
    agents: list[dict] = scenario["agents"]
    n = len(agents)

    client = build_async_client(settings)

    state = DashboardState.initial(
        agents,
        topic=topic,
        scenario=scenario_name,
        model_id=settings.model,
        slot_total=n,
    )
    queue: asyncio.Queue = asyncio.Queue()
    stop_event = asyncio.Event()
    server_snapshot: list[ServerMetrics] = [ServerMetrics()]

    async def _metrics_mirror() -> None:
        while not stop_event.is_set():
            state.server = server_snapshot[0]
            await asyncio.sleep(0.25)

    dashboard_task = asyncio.create_task(run_dashboard(state, queue, stop_event))
    metrics_task = asyncio.create_task(
        poll_metrics_loop(client, settings.model, server_snapshot, stop_event)
    )
    mirror_task = asyncio.create_task(_metrics_mirror())

    exit_code = 0
    try:
        task_specs = await _run_plan(
            client,
            model=settings.model,
            scenario=scenario,
            topic=topic,
            n_agents=n,
        )
        task_by_name = {t.get("name"): t for t in task_specs}

        agent_tasks = [
            _run_agent(
                client,
                model=settings.model,
                agent=agent,
                task=task_by_name.get(
                    agent["name"],
                    {"name": agent["name"], "instruction": agent[
                        "direct_instruction"
                    ].replace("{topic}", topic)},
                ),
                system_prompt=scenario.get("system_prompt", ""),
                queue=queue,
            )
            for agent in agents
        ]

        gathered = await asyncio.gather(*agent_tasks, return_exceptions=True)
        results: dict[str, str] = {}
        failed = 0
        for item in gathered:
            if isinstance(item, BaseException):
                failed += 1
                continue
            name, content, ok = item
            if ok:
                results[name] = content
            else:
                failed += 1

        if failed:
            exit_code = 1

        BUILD_DIR.mkdir(parents=True, exist_ok=True)
        html_path = BUILD_DIR / "index.html"
        html_path.write_text(
            build_page(topic, scenario, results, tasks=task_specs),
            encoding="utf-8",
        )

        if open_browser:
            _open_in_browser(html_path)
    finally:
        await queue.put(None)
        stop_event.set()
        for task in (mirror_task, metrics_task, dashboard_task):
            try:
                await task
            except asyncio.CancelledError:
                pass
        await client.aclose()

    print(f"\nHTML report: {html_path}")
    return exit_code


def _open_in_browser(path: pathlib.Path) -> None:
    """Best-effort cross-platform `open` of the rendered gallery."""
    url = path.as_uri()
    try:
        if sys.platform == "darwin":
            subprocess.run(["open", str(path)], check=False)
            return
        if sys.platform == "win32":
            subprocess.run(["cmd", "/c", "start", "", str(path)], check=False)
            return
        webbrowser.open(url)
    except Exception:
        pass


@app.command()
def run(
    scenario: str = typer.Option(
        "ascii", "--scenario", "-s", help="Scenario name: svg | translate | code | ascii"
    ),
    topic: str = typer.Option(
        "animals",
        "--topic",
        "-t",
        help="Free-form topic passed to both the orchestrator and each agent.",
    ),
    tasks: int | None = typer.Option(
        8,
        "--tasks",
        "-n",
        min=1,
        max=20,
        help="Number of concurrent agents (should equal llama.cpp concurrent_slots).",
    ),
    no_browser: bool = typer.Option(
        False, "--no-browser", help="Do not auto-open the rendered HTML page."
    ),
) -> None:
    """Fan out N concurrent agents against Atomic-Chat's local API server."""
    exit_code = asyncio.run(
        _run(
            scenario_name=scenario,
            topic=topic,
            tasks=tasks,
            open_browser=not no_browser,
        )
    )
    raise typer.Exit(exit_code)


if __name__ == "__main__":
    app()
