#!/usr/bin/env python3
"""Opt-in live contract tests for pinned local inference sidecars."""

from __future__ import annotations

import argparse
import json
import os
import shlex
import subprocess
import sys
import tempfile
import time
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from live_test_support import (
    LiveTestError,
    assert_chat_sse_order,
    assert_completion_shape,
    assert_models_shape,
    cancel_stream,
    json_request,
    read_sse,
    sanitize_fixture,
    unused_local_port,
    wait_for_models,
)


@dataclass(frozen=True)
class Sidecar:
    name: str
    env_prefix: str

    @property
    def binary(self) -> str | None:
        return os.environ.get(f"{self.env_prefix}_BIN")

    @property
    def model(self) -> str | None:
        return os.environ.get(f"{self.env_prefix}_MODEL")

    @property
    def tool_support(self) -> bool:
        return os.environ.get(f"{self.env_prefix}_TOOLS") == "1"

    @property
    def extra_args(self) -> list[str]:
        return shlex.split(os.environ.get(f"{self.env_prefix}_EXTRA_ARGS", ""))

    def command(self, port: int, model: str | None = None) -> list[str]:
        binary = self.binary
        if not binary:
            raise LiveTestError(f"{self.env_prefix}_BIN is not set")
        selected_model = model or self.model
        if not selected_model:
            raise LiveTestError(f"{self.env_prefix}_MODEL is not set")
        model_flag = "--model" if self.name == "mlx" else "-m"
        return [
            binary,
            model_flag,
            selected_model,
            "--host",
            "127.0.0.1",
            "--port",
            str(port),
            *self.extra_args,
        ]


SIDECARS = {
    "turboquant": Sidecar("turboquant", "ATOMIC_LIVE_TURBOQUANT"),
    "upstream": Sidecar("upstream", "ATOMIC_LIVE_UPSTREAM"),
    "mlx": Sidecar("mlx", "ATOMIC_LIVE_MLX"),
}


def completion_body(
    model: str, *, stream: bool, max_tokens: int = 32
) -> dict[str, Any]:
    return {
        "model": model,
        "messages": [{"role": "user", "content": "Reply with only the word ready."}],
        "temperature": 0,
        "max_tokens": max_tokens,
        "stream": stream,
    }


def test_tool_call(base_url: str, model: str) -> dict[str, Any]:
    body = {
        "model": model,
        "messages": [
            {
                "role": "user",
                "content": "Call get_temperature for location Paris. Do not answer directly.",
            }
        ],
        "temperature": 0,
        "max_tokens": 64,
        "tools": [
            {
                "type": "function",
                "function": {
                    "name": "get_temperature",
                    "description": "Get the current temperature",
                    "parameters": {
                        "type": "object",
                        "properties": {"location": {"type": "string"}},
                        "required": ["location"],
                    },
                },
            }
        ],
        "tool_choice": {
            "type": "function",
            "function": {"name": "get_temperature"},
        },
    }
    status, payload = json_request(
        f"{base_url}/v1/chat/completions", method="POST", body=body, timeout=90
    )
    if status != 200:
        raise LiveTestError(f"tool-call completion returned HTTP {status}: {payload!r}")
    assert_completion_shape(payload)
    tool_calls = payload["choices"][0]["message"].get("tool_calls")
    if not isinstance(tool_calls, list) or not tool_calls:
        raise LiveTestError("tool support was declared but no tool_calls were returned")
    if tool_calls[0].get("function", {}).get("name") != "get_temperature":
        raise LiveTestError(f"unexpected tool call: {tool_calls[0]!r}")
    return payload


def validate_bad_model(sidecar: Sidecar, timeout: float) -> None:
    bad_path = str(Path(tempfile.gettempdir()) / "atomic-model-does-not-exist")
    process = subprocess.Popen(
        sidecar.command(unused_local_port(), bad_path),
        stdout=subprocess.DEVNULL,
        stderr=subprocess.PIPE,
        text=True,
    )
    try:
        try:
            _, stderr = process.communicate(timeout=timeout)
        except subprocess.TimeoutExpired as error:
            raise LiveTestError(
                f"bad model path did not make the sidecar exit within {timeout:g}s"
            ) from error
        if process.returncode == 0:
            raise LiveTestError("bad model path unexpectedly exited successfully")
        if not stderr.strip():
            raise LiveTestError("bad model path failed without an error message")
    finally:
        if process.poll() is None:
            process.terminate()
            process.wait(timeout=5)


def run_sidecar(sidecar: Sidecar, startup_timeout: float, output_dir: Path) -> None:
    binary = Path(sidecar.binary or "")
    model = Path(sidecar.model or "")
    if not binary.is_file():
        raise LiveTestError(f"{sidecar.env_prefix}_BIN is not a file: {binary}")
    if not os.access(binary, os.X_OK):
        raise LiveTestError(f"{sidecar.env_prefix}_BIN is not executable: {binary}")
    if not model.exists():
        raise LiveTestError(f"{sidecar.env_prefix}_MODEL does not exist: {model}")

    port = unused_local_port()
    base_url = f"http://127.0.0.1:{port}"
    with tempfile.TemporaryFile(mode="w+t", encoding="utf-8") as sidecar_log:
        process = subprocess.Popen(
            sidecar.command(port),
            stdout=sidecar_log,
            stderr=subprocess.STDOUT,
            text=True,
        )
        try:
            models = wait_for_models(base_url, startup_timeout)
            health_status, health = json_request(f"{base_url}/health", timeout=10)
            if health_status != 200:
                raise LiveTestError(
                    f"readiness endpoint returned HTTP {health_status}: {health!r}"
                )
            assert_models_shape(models)
            model_id = str(models["data"][0]["id"])
            print(f"  PASS readiness and /v1/models ({model_id})")

            status, payload = json_request(
                f"{base_url}/v1/chat/completions",
                method="POST",
                body=completion_body(model_id, stream=False),
                timeout=90,
            )
            if status != 200:
                raise LiveTestError(
                    f"normal completion returned HTTP {status}: {payload!r}"
                )
            assert_completion_shape(payload)
            print("  PASS normal completion")

            events = read_sse(
                f"{base_url}/v1/chat/completions",
                completion_body(model_id, stream=True),
                timeout=90,
            )
            assert_chat_sse_order(events)
            print("  PASS SSE ordering")

            cancel_stream(
                f"{base_url}/v1/chat/completions",
                completion_body(model_id, stream=True, max_tokens=256),
            )
            time.sleep(0.25)
            assert_models_shape(wait_for_models(base_url, 10))
            print("  PASS client cancellation and recovery")

            tool_payload = None
            if sidecar.tool_support:
                tool_payload = test_tool_call(base_url, model_id)
                print("  PASS tool call")
            else:
                print(f"  SKIP tool call ({sidecar.env_prefix}_TOOLS is not 1)")

            cassette = {
                "schema_version": 1,
                "provider": sidecar.name,
                "models": sanitize_fixture(models),
                "normal": sanitize_fixture(payload),
                "stream": sanitize_fixture(events),
            }
            if tool_payload is not None:
                cassette["tool"] = sanitize_fixture(tool_payload)
            output_dir.mkdir(parents=True, exist_ok=True)
            output_path = output_dir / f"{sidecar.name}.json"
            output_path.write_text(
                json.dumps(cassette, indent=2, sort_keys=True) + "\n",
                encoding="utf-8",
            )
            print(f"  PASS wrote sanitized cassette {output_path}")
        finally:
            process.terminate()
            try:
                process.wait(timeout=10)
            except subprocess.TimeoutExpired:
                process.kill()
                process.wait(timeout=5)
            if process.returncode not in (0, -15):
                sidecar_log.seek(0)
                log = sidecar_log.read().strip()
                if log:
                    print(f"  sidecar log tail: {log[-1000:]}", file=sys.stderr)

    validate_bad_model(sidecar, min(startup_timeout, 30))
    print("  PASS bad model path error")


def prerequisites(sidecar: Sidecar) -> list[str]:
    missing = []
    for suffix in ("BIN", "MODEL"):
        name = f"{sidecar.env_prefix}_{suffix}"
        if not os.environ.get(name):
            missing.append(name)
    return missing


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument(
        "--backend",
        action="append",
        choices=[*SIDECARS, "all"],
        help="backend to test; repeatable (default: all)",
    )
    parser.add_argument(
        "--require",
        action="store_true",
        help="fail instead of skipping backends with missing environment variables",
    )
    parser.add_argument(
        "--startup-timeout",
        type=float,
        default=float(os.environ.get("ATOMIC_LIVE_STARTUP_TIMEOUT", "120")),
    )
    parser.add_argument(
        "--output-dir",
        type=Path,
        default=Path(__file__).resolve().parents[1]
        / "tests"
        / "fixtures"
        / "live-sidecars",
    )
    args = parser.parse_args()

    requested = args.backend or ["all"]
    names = list(SIDECARS) if "all" in requested else list(dict.fromkeys(requested))
    tested = 0
    failures = 0
    for name in names:
        sidecar = SIDECARS[name]
        missing = prerequisites(sidecar)
        if missing:
            message = f"{name}: missing {', '.join(missing)}"
            if args.require:
                print(f"FAIL {message}", file=sys.stderr)
                failures += 1
            else:
                print(f"SKIP {message}")
            continue
        print(f"TEST {name}")
        try:
            run_sidecar(sidecar, args.startup_timeout, args.output_dir)
            tested += 1
        except (LiveTestError, OSError, ValueError) as error:
            print(f"FAIL {name}: {error}", file=sys.stderr)
            failures += 1

    if failures:
        return 1
    if not tested:
        print("SKIP no configured local sidecars")
    return 0


if __name__ == "__main__":
    raise SystemExit(main())
