#!/usr/bin/env bash
# Start Demo.command — Double-clickable launcher for the Atomic-Chat
# Concurrent Demo, designed for non-technical users (marketers, presenters).
#
# macOS users can simply double-click this file in Finder; the script will:
#   1. Ensure `uv` (the Python package manager) is installed.
#   2. Verify Atomic-Chat's local API server is reachable.
#   3. Check that the target model is loaded and answering.
#   4. Launch the multi-window demo with sensible defaults.
#
# Everything is logged to the same Terminal window so the user can see what's
# happening. The script stays open on failure so error messages are readable.
set -u

cd "$(dirname "$0")"

# ─── Configuration (overridable via environment) ──────────────────────────
: "${ATOMIC_BASE_URL:=http://127.0.0.1:1337/v1}"
: "${ATOMIC_MODEL:=gemma-4-E4B-it-IQ4_XS}"
: "${DEMO_SCENARIO:=ascii}"
: "${DEMO_TOPIC:=cats}"
: "${DEMO_TASKS:=16}"

BOLD=$'\033[1m'
DIM=$'\033[2m'
RED=$'\033[31m'
GREEN=$'\033[32m'
YELLOW=$'\033[33m'
CYAN=$'\033[36m'
RESET=$'\033[0m'

say()   { printf '%s▸%s %s\n'   "$CYAN"   "$RESET" "$*"; }
ok()    { printf '%s✓%s %s\n'   "$GREEN"  "$RESET" "$*"; }
warn()  { printf '%s⚠%s %s\n'   "$YELLOW" "$RESET" "$*"; }
fail()  { printf '%s✗%s %s\n'   "$RED"    "$RESET" "$*" >&2; }
header() {
    printf '\n%s%s%s\n' "$BOLD" "$1" "$RESET"
    printf '%s%s%s\n' "$DIM" "────────────────────────────────────────────────────────" "$RESET"
}

pause_and_exit() {
    local code="${1:-1}"
    printf '\n%sPress Enter to close this window…%s ' "$DIM" "$RESET"
    read -r _ || true
    exit "$code"
}

clear
header "Atomic-Chat · Concurrent Demo"
printf '%sscenario:%s %s   %stopic:%s %s   %stasks:%s %s   %smodel:%s %s\n' \
    "$DIM" "$RESET" "$DEMO_SCENARIO" \
    "$DIM" "$RESET" "$DEMO_TOPIC" \
    "$DIM" "$RESET" "$DEMO_TASKS" \
    "$DIM" "$RESET" "$ATOMIC_MODEL"

# ─── Step 1: ensure `uv` is installed ─────────────────────────────────────
header "1/4  Python toolchain (uv)"
if command -v uv >/dev/null 2>&1; then
    ok "uv found: $(uv --version 2>/dev/null || echo 'uv')"
else
    warn "uv is not installed — installing from https://astral.sh/uv..."
    if ! command -v curl >/dev/null 2>&1; then
        fail "curl is required to bootstrap uv but was not found in PATH."
        pause_and_exit 1
    fi
    if ! curl -LsSf https://astral.sh/uv/install.sh | sh; then
        fail "Failed to install uv. See https://docs.astral.sh/uv/ for manual install."
        pause_and_exit 1
    fi
    # `uv` installs itself to ~/.local/bin (or ~/.cargo/bin on older releases).
    export PATH="$HOME/.local/bin:$HOME/.cargo/bin:$PATH"
    if ! command -v uv >/dev/null 2>&1; then
        fail "uv installed but not found on PATH. Restart your Terminal and try again."
        pause_and_exit 1
    fi
    ok "uv installed."
fi

# ─── Step 2: verify Atomic-Chat is running ────────────────────────────────
header "2/4  Atomic-Chat local API"
say  "Checking $ATOMIC_BASE_URL/models …"
if ! curl --silent --fail --max-time 4 "$ATOMIC_BASE_URL/models" >/dev/null 2>&1; then
    fail "Atomic-Chat local API server is not reachable at $ATOMIC_BASE_URL."
    cat <<EOF

  To fix this:
    1. Open the Atomic-Chat app.
    2. Go to Settings → Local API Server and make sure it is running.
    3. Re-launch this demo.

EOF
    pause_and_exit 1
fi
ok "Local API reachable."

# ─── Step 3: verify the target model is loaded ────────────────────────────
header "3/4  Model readiness"
say  "Pinging model '$ATOMIC_MODEL' with a short completion…"
PING_BODY=$(cat <<JSON
{"model":"$ATOMIC_MODEL","messages":[{"role":"user","content":"ping"}],"max_tokens":1,"stream":false}
JSON
)
HTTP_CODE=$(
    curl --silent --show-error --max-time 20 \
        -o /tmp/atomic-demo-ping.$$.json \
        -w '%{http_code}' \
        -H 'Content-Type: application/json' \
        ${ATOMIC_API_KEY:+-H "Authorization: Bearer $ATOMIC_API_KEY"} \
        --data "$PING_BODY" \
        "$ATOMIC_BASE_URL/chat/completions" || echo '000'
)
if [[ "$HTTP_CODE" != "200" ]]; then
    fail "Model '$ATOMIC_MODEL' did not respond (HTTP $HTTP_CODE)."
    if [[ -s /tmp/atomic-demo-ping.$$.json ]]; then
        printf '%sresponse:%s ' "$DIM" "$RESET"
        head -c 400 /tmp/atomic-demo-ping.$$.json
        printf '\n'
    fi
    cat <<EOF

  To fix this:
    1. Open Atomic-Chat → Settings → Providers → Llama.cpp (or TurboQuant).
    2. Make sure the model '$ATOMIC_MODEL' is installed and started.
    3. Enable "Concurrent Mode" and set Concurrent Slots to $DEMO_TASKS.
    4. Re-launch this demo.

EOF
    rm -f /tmp/atomic-demo-ping.$$.json
    pause_and_exit 1
fi
rm -f /tmp/atomic-demo-ping.$$.json
ok "Model is loaded and responding."

# ─── Step 4: launch the demo in multi-window mode ─────────────────────────
header "4/4  Launching $DEMO_TASKS concurrent agents"
say "Opening $DEMO_TASKS Terminal windows (one per agent)…"
uv sync --quiet || {
    fail "Failed to sync Python dependencies (uv sync)."
    pause_and_exit 1
}

# Export the resolved settings so the orchestrator picks them up.
export ATOMIC_BASE_URL ATOMIC_MODEL
if [[ -n "${ATOMIC_API_KEY:-}" ]]; then
    export ATOMIC_API_KEY
fi

set +e
uv run python -m demo.main run \
    --scenario "$DEMO_SCENARIO" \
    --topic    "$DEMO_TOPIC" \
    --tasks    "$DEMO_TASKS" \
    --multi-window
RUN_CODE=$?
set -e

printf '\n'
if [[ "$RUN_CODE" -eq 0 ]]; then
    ok "Demo finished successfully. HTML report opened in your browser."
else
    warn "Demo finished with exit code $RUN_CODE (some agents may have failed)."
fi
pause_and_exit "$RUN_CODE"
