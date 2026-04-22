"""
demo/metrics.py — Prometheus /metrics poller for Atomic-Chat's proxied
llama-server endpoint.

The Atomic-Chat proxy exposes llama-server's metrics at
``{base_url}/metrics?model={model_id}`` (see
src-tauri/src/core/server/proxy.rs). This module polls that endpoint on a
fixed interval and exposes the most recent sample as a dataclass-shaped
snapshot for the dashboard to render.

Nothing here is llama-server-private: we only rely on the documented
``llamacpp:*`` metric family names.
"""

from __future__ import annotations

import asyncio
from dataclasses import dataclass

import httpx

POLL_INTERVAL_SECONDS = 0.5


@dataclass(slots=True)
class ServerMetrics:
    """Snapshot of the most recent llama-server /metrics scrape."""

    kv_cache_usage_ratio: float = 0.0
    requests_processing: float = 0.0
    requests_deferred: float = 0.0
    prompt_tokens_total: float = 0.0
    predicted_tokens_total: float = 0.0
    predicted_tokens_per_second: float = 0.0
    available: bool = False

    def summary_line(self, slot_total: int) -> str:
        """Return a compact one-line summary for the dashboard footer."""
        active = int(self.requests_processing)
        kv_pct = int(self.kv_cache_usage_ratio * 100)
        tps = self.predicted_tokens_per_second
        return (
            f"Slots {active}/{slot_total} \u2022 "
            f"KV {kv_pct}% \u2022 "
            f"{tps:.0f} tok/s"
        )


def parse_prometheus_text(text: str) -> dict[str, float]:
    """Parse a Prometheus exposition-format text blob into a flat dict.

    Labels are ignored; the last value wins if a metric appears more than
    once. This is sufficient for the single-session metrics llama-server
    emits.
    """
    result: dict[str, float] = {}
    for line in text.splitlines():
        if not line or line.startswith("#"):
            continue
        # Strip an optional `{labels...}` segment.
        if "{" in line and "}" in line:
            name = line.split("{", 1)[0]
            value_part = line.split("}", 1)[1].strip()
        else:
            parts = line.split(maxsplit=1)
            if len(parts) != 2:
                continue
            name, value_part = parts
        value_str = value_part.split()[0] if value_part else ""
        try:
            result[name] = float(value_str)
        except ValueError:
            continue
    return result


def metrics_from_prometheus(values: dict[str, float]) -> ServerMetrics:
    """Convert a parsed Prometheus dict into a ServerMetrics snapshot."""
    return ServerMetrics(
        kv_cache_usage_ratio=values.get("llamacpp:kv_cache_usage_ratio", 0.0),
        requests_processing=values.get("llamacpp:requests_processing", 0.0),
        requests_deferred=values.get("llamacpp:requests_deferred", 0.0),
        prompt_tokens_total=values.get("llamacpp:prompt_tokens_total", 0.0),
        predicted_tokens_total=values.get("llamacpp:n_predict_total", 0.0)
        or values.get("llamacpp:tokens_predicted_total", 0.0),
        predicted_tokens_per_second=values.get(
            "llamacpp:predicted_tokens_seconds", 0.0
        ),
        available=True,
    )


async def poll_metrics_loop(
    client: httpx.AsyncClient,
    model_id: str,
    snapshot: list[ServerMetrics],
    stop_event: asyncio.Event,
) -> None:
    """Continuously refresh `snapshot[0]` until `stop_event` is set.

    `snapshot` is a single-element list used as a mutable container so the
    dashboard and this poller can share a reference without coordinating
    through a Queue; the poller only ever replaces `snapshot[0]`.
    """
    url = f"/metrics?model={model_id}"
    while not stop_event.is_set():
        try:
            resp = await client.get(url, timeout=2.0)
            if resp.status_code == 200:
                snapshot[0] = metrics_from_prometheus(
                    parse_prometheus_text(resp.text)
                )
            else:
                snapshot[0] = ServerMetrics()
        except (httpx.HTTPError, OSError):
            # llama-server not yet ready / --metrics disabled — keep polling,
            # but surface that by marking the snapshot unavailable.
            snapshot[0] = ServerMetrics()
        try:
            await asyncio.wait_for(
                stop_event.wait(), timeout=POLL_INTERVAL_SECONDS
            )
        except asyncio.TimeoutError:
            pass
