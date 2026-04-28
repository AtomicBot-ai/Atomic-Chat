#!/usr/bin/env bash
# run.sh — Thin wrapper that ensures the uv environment is synced and then
# delegates to the Python orchestrator. All CLI flags are forwarded as-is.
#
# Usage:
#   bash run.sh --scenario ascii --topic "cats" --tasks 8
set -euo pipefail

cd "$(dirname "$0")"

if ! command -v uv >/dev/null 2>&1; then
    echo "error: 'uv' is required. Install: https://docs.astral.sh/uv/" >&2
    exit 1
fi

uv sync --quiet
exec uv run python -m demo.main "$@"
