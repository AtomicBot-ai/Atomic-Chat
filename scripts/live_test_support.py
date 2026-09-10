"""Standard-library helpers for opt-in live API contract tests."""

from __future__ import annotations

import http.client
import json
import os
import socket
import time
import urllib.error
import urllib.parse
import urllib.request
from collections.abc import Iterable
from pathlib import Path
from typing import Any


class LiveTestError(RuntimeError):
    pass


def load_local_env(path: Path) -> None:
    """Load simple KEY=VALUE entries without overriding the process environment."""
    if not path.exists():
        return
    for raw_line in path.read_text(encoding="utf-8").splitlines():
        line = raw_line.strip()
        if not line or line.startswith("#") or "=" not in line:
            continue
        key, value = line.split("=", 1)
        key = key.strip()
        value = value.strip()
        if value and value[0] in {"'", '"'} and value[-1:] == value[0]:
            value = value[1:-1]
        if key:
            os.environ.setdefault(key, value)


def json_request(
    url: str,
    *,
    method: str = "GET",
    body: dict[str, Any] | None = None,
    headers: dict[str, str] | None = None,
    timeout: float = 30,
) -> tuple[int, Any]:
    request_headers = {"Accept": "application/json", **(headers or {})}
    data = None
    if body is not None:
        data = json.dumps(body).encode("utf-8")
        request_headers.setdefault("Content-Type", "application/json")
    request = urllib.request.Request(
        url, data=data, headers=request_headers, method=method
    )
    try:
        with urllib.request.urlopen(request, timeout=timeout) as response:
            payload = response.read()
            return response.status, json.loads(payload) if payload else None
    except urllib.error.HTTPError as error:
        payload = error.read()
        try:
            parsed = json.loads(payload) if payload else None
        except json.JSONDecodeError:
            parsed = payload.decode("utf-8", errors="replace")
        return error.code, parsed


def wait_for_models(base_url: str, timeout: float) -> dict[str, Any]:
    deadline = time.monotonic() + timeout
    last_error = "server did not answer"
    while time.monotonic() < deadline:
        try:
            status, payload = json_request(
                f"{base_url}/v1/models", timeout=min(2, timeout)
            )
            if status == 200 and isinstance(payload, dict):
                return payload
            last_error = f"HTTP {status}: {payload!r}"
        except (OSError, urllib.error.URLError, TimeoutError) as error:
            last_error = str(error)
        time.sleep(0.25)
    raise LiveTestError(f"readiness timed out after {timeout:g}s ({last_error})")


def assert_models_shape(payload: Any) -> None:
    if not isinstance(payload, dict) or payload.get("object") != "list":
        raise LiveTestError(f"/v1/models returned an invalid envelope: {payload!r}")
    data = payload.get("data")
    if not isinstance(data, list) or not data:
        raise LiveTestError("/v1/models returned no model entries")
    if not all(isinstance(item, dict) and item.get("id") for item in data):
        raise LiveTestError("/v1/models contains an entry without an id")


def assert_completion_shape(payload: Any) -> None:
    if not isinstance(payload, dict):
        raise LiveTestError(f"completion was not a JSON object: {payload!r}")
    choices = payload.get("choices")
    if not isinstance(choices, list) or not choices:
        raise LiveTestError(f"completion contained no choices: {payload!r}")
    message = choices[0].get("message")
    if not isinstance(message, dict) or message.get("role") != "assistant":
        raise LiveTestError(f"completion contained no assistant message: {payload!r}")


def read_sse(
    url: str,
    body: dict[str, Any],
    headers: dict[str, str] | None = None,
    timeout: float = 60,
) -> list[Any]:
    request_headers = {
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
        **(headers or {}),
    }
    request = urllib.request.Request(
        url,
        data=json.dumps(body).encode("utf-8"),
        headers=request_headers,
        method="POST",
    )
    events: list[Any] = []
    with urllib.request.urlopen(request, timeout=timeout) as response:
        content_type = response.headers.get_content_type()
        if content_type != "text/event-stream":
            raise LiveTestError(f"stream content type was {content_type!r}")
        for raw_line in response:
            line = raw_line.decode("utf-8", errors="strict").strip()
            if not line or line.startswith(":") or not line.startswith("data:"):
                continue
            data = line[5:].strip()
            if data == "[DONE]":
                events.append("[DONE]")
                break
            events.append(json.loads(data))
    return events


def assert_chat_sse_order(events: Iterable[Any]) -> None:
    sequence = list(events)
    if not sequence:
        raise LiveTestError("SSE stream emitted no data events")
    if sequence[-1] != "[DONE]":
        raise LiveTestError("SSE stream did not terminate with data: [DONE]")
    if "[DONE]" in sequence[:-1]:
        raise LiveTestError("SSE [DONE] marker appeared before the final event")
    chunks = sequence[:-1]
    if not chunks or not all(isinstance(chunk, dict) for chunk in chunks):
        raise LiveTestError("SSE stream did not contain JSON chunks before [DONE]")
    choice_chunks = [
        chunk
        for chunk in chunks
        if isinstance(chunk.get("choices"), list) and chunk["choices"]
    ]
    if not choice_chunks:
        raise LiveTestError("SSE stream contained no choice chunks")
    finish_indexes = [
        index
        for index, chunk in enumerate(choice_chunks)
        if chunk["choices"][0].get("finish_reason") is not None
    ]
    if finish_indexes and finish_indexes[-1] != len(choice_chunks) - 1:
        raise LiveTestError("SSE finish_reason was followed by another choice chunk")


def cancel_stream(
    url: str,
    body: dict[str, Any],
    headers: dict[str, str] | None = None,
    timeout: float = 20,
) -> None:
    parsed = urllib.parse.urlsplit(url)
    connection_class = (
        http.client.HTTPSConnection
        if parsed.scheme == "https"
        else http.client.HTTPConnection
    )
    connection = connection_class(parsed.hostname, parsed.port, timeout=timeout)
    path = urllib.parse.urlunsplit(("", "", parsed.path, parsed.query, ""))
    request_headers = {
        "Accept": "text/event-stream",
        "Content-Type": "application/json",
        **(headers or {}),
    }
    connection.request("POST", path, json.dumps(body), request_headers)
    response = connection.getresponse()
    if response.status >= 400:
        raise LiveTestError(f"cancellation request returned HTTP {response.status}")
    response.readline()
    connection.close()


def unused_local_port() -> int:
    with socket.socket(socket.AF_INET, socket.SOCK_STREAM) as listener:
        listener.bind(("127.0.0.1", 0))
        return int(listener.getsockname()[1])


_DYNAMIC_STRING_KEYS = {
    "id",
    "model",
    "system_fingerprint",
    "request_id",
    "call_id",
}
_TEXT_KEYS = {"content", "text", "arguments", "output", "delta"}
_TIME_KEYS = {"created", "created_at"}
_TOKEN_KEYS = {
    "prompt_tokens",
    "completion_tokens",
    "total_tokens",
    "input_tokens",
    "output_tokens",
}


def sanitize_fixture(value: Any, key: str | None = None) -> Any:
    """Preserve response shape while removing provider-specific dynamic values."""
    if isinstance(value, dict):
        return {
            item_key: sanitize_fixture(item_value, item_key)
            for item_key, item_value in sorted(value.items())
            if item_key.lower() not in {"api_key", "authorization"}
        }
    if isinstance(value, list):
        return [sanitize_fixture(item, key) for item in value]
    if key in _DYNAMIC_STRING_KEYS and isinstance(value, str):
        return f"<{key}>"
    if key in _TEXT_KEYS and isinstance(value, str):
        if value in {"", "[DONE]"}:
            return value
        return f"<{key}>"
    if key in _TIME_KEYS and isinstance(value, (int, float)):
        return 0
    if key in _TOKEN_KEYS and isinstance(value, int):
        return 1
    return value
