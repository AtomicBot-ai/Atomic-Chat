#!/usr/bin/env python3
"""Record sanitized response-shape cassettes from opt-in cloud providers."""

from __future__ import annotations

import argparse
import json
import os
import re
import sys
from dataclasses import dataclass
from pathlib import Path
from typing import Any

from live_test_support import (
    LiveTestError,
    assert_chat_sse_order,
    assert_completion_shape,
    json_request,
    load_local_env,
    read_sse,
    sanitize_fixture,
)

ROOT = Path(__file__).resolve().parents[1]
DEFAULT_ENV = ROOT / ".env.test.local"
DEFAULT_OUTPUT = ROOT / "tests" / "fixtures" / "live-cloud"


@dataclass(frozen=True)
class Provider:
    name: str
    style: str
    base_url: str
    api_key: str
    model: str
    tool_support: bool

    @property
    def headers(self) -> dict[str, str]:
        if self.style == "anthropic":
            return {
                "x-api-key": self.api_key,
                "anthropic-version": os.environ.get(
                    "ATOMIC_CLOUD_ANTHROPIC_VERSION", "2023-06-01"
                ),
            }
        return {"Authorization": f"Bearer {self.api_key}"}

    @property
    def completion_url(self) -> str:
        endpoint = "messages" if self.style == "anthropic" else "chat/completions"
        return f"{self.base_url.rstrip('/')}/{endpoint}"

    @property
    def models_url(self) -> str:
        return f"{self.base_url.rstrip('/')}/models"

    def normal_body(self) -> dict[str, Any]:
        if self.style == "anthropic":
            return {
                "model": self.model,
                "messages": [{"role": "user", "content": "Reply with only: ready"}],
                "max_tokens": 32,
                "temperature": 0,
            }
        return {
            "model": self.model,
            "messages": [{"role": "user", "content": "Reply with only: ready"}],
            "max_tokens": 32,
            "temperature": 0,
            "stream": False,
        }

    def stream_body(self) -> dict[str, Any]:
        return {**self.normal_body(), "stream": True}

    def tool_body(self) -> dict[str, Any]:
        if self.style == "anthropic":
            return {
                "model": self.model,
                "messages": [
                    {
                        "role": "user",
                        "content": "Use get_temperature for Paris. Do not answer directly.",
                    }
                ],
                "max_tokens": 64,
                "temperature": 0,
                "tools": [
                    {
                        "name": "get_temperature",
                        "description": "Get the current temperature",
                        "input_schema": {
                            "type": "object",
                            "properties": {"location": {"type": "string"}},
                            "required": ["location"],
                        },
                    }
                ],
                "tool_choice": {"type": "tool", "name": "get_temperature"},
            }
        return {
            "model": self.model,
            "messages": [
                {
                    "role": "user",
                    "content": "Use get_temperature for Paris. Do not answer directly.",
                }
            ],
            "max_tokens": 64,
            "temperature": 0,
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


def env_name(provider_name: str, suffix: str) -> str:
    normalized = re.sub(r"[^A-Za-z0-9]", "_", provider_name).upper()
    return f"ATOMIC_CLOUD_{normalized}_{suffix}"


def configured_providers() -> tuple[list[Provider], list[str]]:
    names = [
        item.strip()
        for item in os.environ.get("ATOMIC_CLOUD_PROVIDERS", "").split(",")
        if item.strip()
    ]
    providers: list[Provider] = []
    errors: list[str] = []
    for name in names:
        values = {
            suffix: os.environ.get(env_name(name, suffix), "")
            for suffix in ("BASE_URL", "API_KEY", "MODEL")
        }
        missing = [env_name(name, key) for key, value in values.items() if not value]
        if missing:
            errors.append(f"{name}: missing {', '.join(missing)}")
            continue
        style = os.environ.get(env_name(name, "STYLE"), "openai").lower()
        if style not in {"openai", "anthropic"}:
            errors.append(
                f"{name}: {env_name(name, 'STYLE')} must be openai or anthropic"
            )
            continue
        providers.append(
            Provider(
                name=name,
                style=style,
                base_url=values["BASE_URL"],
                api_key=values["API_KEY"],
                model=values["MODEL"],
                tool_support=os.environ.get(env_name(name, "TOOLS")) == "1",
            )
        )
    return providers, errors


def validate_anthropic(payload: Any) -> None:
    if not isinstance(payload, dict) or payload.get("type") != "message":
        raise LiveTestError(f"invalid Anthropic message envelope: {payload!r}")
    if not isinstance(payload.get("content"), list):
        raise LiveTestError(f"Anthropic message has no content blocks: {payload!r}")


def validate_anthropic_sse(events: list[Any]) -> None:
    types = [
        event.get("type")
        for event in events
        if isinstance(event, dict) and isinstance(event.get("type"), str)
    ]
    if not types or types[0] != "message_start":
        raise LiveTestError(f"Anthropic SSE did not start with message_start: {types}")
    if types[-1] != "message_stop":
        raise LiveTestError(f"Anthropic SSE did not end with message_stop: {types}")


def record_provider(provider: Provider, output_dir: Path) -> Path:
    models_status, models = json_request(
        provider.models_url,
        headers=provider.headers,
        timeout=60,
    )
    if models_status != 200 or not isinstance(models, dict):
        raise LiveTestError(f"models request returned HTTP {models_status}: {models!r}")
    if not isinstance(models.get("data"), list):
        raise LiveTestError(f"models response has no data array: {models!r}")

    status, normal = json_request(
        provider.completion_url,
        method="POST",
        body=provider.normal_body(),
        headers=provider.headers,
        timeout=120,
    )
    if status != 200:
        raise LiveTestError(f"normal request returned HTTP {status}: {normal!r}")
    if provider.style == "anthropic":
        validate_anthropic(normal)
    else:
        assert_completion_shape(normal)

    invalid_headers = dict(provider.headers)
    if provider.style == "anthropic":
        invalid_headers["x-api-key"] = "atomic-invalid-key"
    else:
        invalid_headers["Authorization"] = "Bearer atomic-invalid-key"
    invalid_status, _ = json_request(
        provider.completion_url,
        method="POST",
        body=provider.normal_body(),
        headers=invalid_headers,
        timeout=60,
    )
    if invalid_status not in {401, 403}:
        raise LiveTestError(f"invalid API key was not rejected (HTTP {invalid_status})")

    stream = read_sse(
        provider.completion_url,
        provider.stream_body(),
        provider.headers,
        timeout=120,
    )
    if provider.style == "anthropic":
        validate_anthropic_sse(stream)
    else:
        assert_chat_sse_order(stream)

    cassette: dict[str, Any] = {
        "schema_version": 1,
        "provider": provider.name,
        "style": provider.style,
        "models": sanitize_fixture(models),
        "normal": sanitize_fixture(normal),
        "stream": sanitize_fixture(stream),
    }
    if provider.tool_support:
        status, tool = json_request(
            provider.completion_url,
            method="POST",
            body=provider.tool_body(),
            headers=provider.headers,
            timeout=120,
        )
        if status != 200:
            raise LiveTestError(f"tool request returned HTTP {status}: {tool!r}")
        if provider.style == "anthropic":
            validate_anthropic(tool)
            if not any(
                block.get("type") == "tool_use"
                for block in tool.get("content", [])
                if isinstance(block, dict)
            ):
                raise LiveTestError(
                    "provider declared tool support but returned no tool_use"
                )
        else:
            assert_completion_shape(tool)
            if not tool["choices"][0]["message"].get("tool_calls"):
                raise LiveTestError(
                    "provider declared tool support but returned no tool_calls"
                )
        cassette["tool"] = sanitize_fixture(tool)

    output_dir.mkdir(parents=True, exist_ok=True)
    safe_name = re.sub(r"[^A-Za-z0-9_.-]", "_", provider.name)
    output_path = output_dir / f"{safe_name}.json"
    output_path.write_text(
        json.dumps(cassette, indent=2, sort_keys=True) + "\n", encoding="utf-8"
    )
    return output_path


def main() -> int:
    parser = argparse.ArgumentParser()
    parser.add_argument("--env-file", type=Path, default=DEFAULT_ENV)
    parser.add_argument("--output-dir", type=Path, default=DEFAULT_OUTPUT)
    parser.add_argument(
        "--require",
        action="store_true",
        help="fail when no provider is configured",
    )
    args = parser.parse_args()
    load_local_env(args.env_file)

    providers, config_errors = configured_providers()
    for error in config_errors:
        print(f"FAIL {error}", file=sys.stderr)
    if config_errors:
        return 1
    if not providers:
        message = (
            "no cloud providers configured; set ATOMIC_CLOUD_PROVIDERS and "
            "provider-specific BASE_URL/API_KEY/MODEL variables"
        )
        if args.require:
            print(f"FAIL {message}", file=sys.stderr)
            return 1
        print(f"SKIP {message}")
        return 0

    failures = 0
    for provider in providers:
        print(f"RECORD {provider.name} ({provider.style})")
        try:
            path = record_provider(provider, args.output_dir)
            print(f"  PASS wrote sanitized cassette {path}")
        except (LiveTestError, OSError, ValueError) as error:
            print(f"FAIL {provider.name}: {error}", file=sys.stderr)
            failures += 1
    return 1 if failures else 0


if __name__ == "__main__":
    raise SystemExit(main())
