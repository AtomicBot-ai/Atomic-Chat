"""
demo/client.py — Async OpenAI-compatible streaming client for Atomic-Chat.

Talks to Atomic-Chat's built-in local API server (the proxy defined in
`src-tauri/src/core/server/proxy.rs`) which in turn forwards requests to the
running llama.cpp session for the selected model.

Environment variables:
    ATOMIC_BASE_URL   Defaults to http://127.0.0.1:1337/v1.
    ATOMIC_API_KEY    Optional Bearer token. Copy from
                      Settings → Local API Server when the proxy has one set.
    ATOMIC_MODEL      Default model_id used by stream_chat / plan_chat.
"""

from __future__ import annotations

import json
import os
from collections.abc import AsyncIterator
from dataclasses import dataclass

import httpx

DEFAULT_BASE_URL = "http://127.0.0.1:1337/v1"
DEFAULT_MODEL = "gemma-4-E4B-it-IQ4_XS"


@dataclass(frozen=True, slots=True)
class ClientSettings:
    """Resolved settings used to build a shared httpx.AsyncClient."""

    base_url: str
    api_key: str
    model: str

    @classmethod
    def from_env(cls) -> ClientSettings:
        return cls(
            base_url=os.environ.get("ATOMIC_BASE_URL", DEFAULT_BASE_URL).rstrip("/"),
            api_key=os.environ.get("ATOMIC_API_KEY", ""),
            model=os.environ.get("ATOMIC_MODEL", DEFAULT_MODEL),
        )


def build_async_client(settings: ClientSettings) -> httpx.AsyncClient:
    """Construct a shared AsyncClient tuned for N concurrent streams.

    A single client is reused across all agent coroutines so TCP and HTTP/2
    connections can be multiplexed; concurrency is bounded by `max_connections`
    which should comfortably exceed the configured `concurrent_slots` (default
    8) to avoid head-of-line blocking on the keepalive pool.
    """
    headers: dict[str, str] = {"Content-Type": "application/json"}
    if settings.api_key:
        headers["Authorization"] = f"Bearer {settings.api_key}"

    limits = httpx.Limits(max_connections=32, max_keepalive_connections=16)
    timeout = httpx.Timeout(connect=10.0, read=None, write=30.0, pool=30.0)
    # Atomic-Chat's local API server lives on 127.0.0.1, so any system-wide
    # HTTP(S)_PROXY env var would misroute these requests through a corporate
    # proxy that neither knows about nor can reach localhost. Disabling
    # `trust_env` makes the client ignore *_PROXY, NO_PROXY, and .netrc.
    return httpx.AsyncClient(
        base_url=settings.base_url,
        headers=headers,
        limits=limits,
        timeout=timeout,
        http2=True,
        trust_env=False,
    )


def _parse_sse_line(line: str) -> str | None:
    """Extract the JSON payload from a single SSE `data: ...` line.

    Returns None for keep-alive comments, empty frames, and the terminal
    `[DONE]` marker so callers can simply iterate the returned stream.
    """
    if not line or not line.startswith("data:"):
        return None
    payload = line[5:].strip()
    if not payload or payload == "[DONE]":
        return None
    return payload


async def stream_chat(
    client: httpx.AsyncClient,
    *,
    model: str,
    system: str,
    user: str,
    max_tokens: int = 4000,
) -> AsyncIterator[dict]:
    """Stream a chat completion, yielding OpenAI-shape chunk dicts.

    Each yielded chunk is the parsed JSON object from one SSE `data:` frame
    (including the final `usage` frame when `include_usage=True`). The caller
    is responsible for extracting `choices[0].delta.content` or `usage`.

    Raises httpx.HTTPStatusError on non-2xx responses so the orchestrator can
    mark the agent as failed without silently dropping the result.
    """
    messages: list[dict[str, str]] = []
    if system:
        messages.append({"role": "system", "content": system})
    messages.append({"role": "user", "content": user})

    body = {
        "model": model,
        "messages": messages,
        "stream": True,
        "stream_options": {"include_usage": True},
        "max_tokens": max_tokens,
    }

    async with client.stream("POST", "/chat/completions", json=body) as resp:
        resp.raise_for_status()
        async for raw_line in resp.aiter_lines():
            payload = _parse_sse_line(raw_line)
            if payload is None:
                continue
            try:
                yield json.loads(payload)
            except json.JSONDecodeError:
                # Malformed frame — skip rather than crashing the whole run.
                continue
