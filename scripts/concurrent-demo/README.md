# Atomic-Chat Concurrent Demo

A Python / [uv](https://docs.astral.sh/uv/) test harness for Atomic-Chat's
**llama.cpp Concurrent Mode**. It fans out N specialist agents against the
app's local API server, shows live per-agent progress and aggregate KV /
tokens-per-second metrics in the terminal, and renders the final outputs
into a static HTML gallery.

Heavily inspired by (and prompt-compatible with) the
[google-gemma/cookbook `apps/concurrent`](https://github.com/google-gemma/cookbook/tree/main/apps/concurrent)
demo, retargeted at Atomic-Chat's proxy instead of launching `llama-server`
directly.

## Prerequisites

1. **Atomic-Chat running** with its local API server enabled
   (Settings → Local API Server).
2. **llama.cpp provider** configured with a loaded model. The default is
   `gemma-4-E4B-it-IQ4_XS` — any chat-capable GGUF works. To download a
   model, use the Hub in Atomic-Chat.
3. **Concurrent Mode turned on** for that model:
   - Settings → Providers → llamacpp
   - Flip **Concurrent Mode** ON.
   - Set **Concurrent Slots** to `8` (or more, up to 16).
   - **Expose Prometheus /metrics** is auto-enabled when Concurrent Mode is ON.
4. **`ATOMIC_API_KEY`** — if your local API server requires a Bearer token,
   copy it from Settings → Local API Server. Leave empty otherwise.
5. **`uv` installed** — https://docs.astral.sh/uv/getting-started/installation/

## Quickstart

```bash
export ATOMIC_BASE_URL="http://127.0.0.1:1337/v1"   # default
export ATOMIC_API_KEY="<your key or empty>"
export ATOMIC_MODEL="gemma-4-E4B-it-IQ4_XS"

cd scripts/concurrent-demo
bash run.sh --scenario ascii --topic "cats" --tasks 8
```

`run.sh` runs `uv sync` (resolving dependencies into `.venv`) and then
dispatches to `python -m demo.main`. The first run takes a few seconds to
install `httpx`, `rich`, `pydantic`, and `typer`.

## Scenarios

All four scenarios from the cookbook are ported 1-to-1:

```bash
bash run.sh --scenario svg       --topic "Technology and AI" --tasks 8
bash run.sh --scenario translate --topic "Atomic-Chat runs locally" --tasks 8
bash run.sh --scenario code      --topic "FizzBuzz" --tasks 8
bash run.sh --scenario ascii     --topic "animals" --tasks 8
```

Pass `--no-browser` to keep the rendered gallery in
`scripts/concurrent-demo/website_build/index.html` without auto-opening it.

## Environment variables

| Variable | Default | Description |
|----------|---------|-------------|
| `ATOMIC_BASE_URL` | `http://127.0.0.1:1337/v1` | Atomic-Chat local API server root. |
| `ATOMIC_API_KEY` | empty | Bearer token, if required by the proxy. |
| `ATOMIC_MODEL` | `gemma-4-E4B-it-IQ4_XS` | `model` field on every request. |

## What you'll see

```
┌ ⚡ Atomic-Chat — Concurrent Demo   scenario=ascii topic="cats" model=gemma-4-E4B-it-IQ4_XS ┐
└──────────────────────────────────────────────────────────────────────────────────────────┘
┌ 🎨 Agent 1  ⚡ running ┐┌ 🎨 Agent 2  ⚡ running ┐┌ 🎨 Agent 3  ⚡ running ┐
│ 142 tok 31.2 t/s 4.5s │ 98 tok 29.7 t/s 3.3s │ 118 tok 28.8 t/s 4.1s │
│ ... streaming text ..│ ... streaming text ..│ ... streaming text ..│
└──────────────────────┘└──────────────────────┘└──────────────────────┘
...
 8/8 done   0 running   0 errored   Σ 0.0 t/s
 server: Slots 0/8 • KV 12% • 0 tok/s

HTML report: /…/scripts/concurrent-demo/website_build/index.html
```

## Architecture

```
orchestrator plan (1 request)
        │
        ▼
asyncio.gather of N agents ──► httpx.AsyncClient ──► :1337/v1/chat/completions
                                                             │
                           ┌────────── proxy.rs ─────────────┘
                           ▼
                     llama-server (--parallel N --cont-batching --metrics)
                           ▲
metrics poller (every 0.5s) ┘  GET /v1/metrics?model=…
        │
        ▼
Rich Live dashboard (per-agent grid + footer summary)
        │
        ▼
HTML gallery (scripts/concurrent-demo/website_build/index.html)
```

## Differences from the cookbook

- No launcher script, no AppleScript, no per-agent Terminal windows — the
  demo runs as a single process that renders in whatever terminal you
  invoke it from.
- No direct `localhost:8080` connection — all traffic goes through
  Atomic-Chat's proxy (`/v1/chat/completions`) so the app owns the
  `llama-server` lifecycle.
- Prometheus metrics come from `/v1/metrics?model=<id>`, which the proxy
  forwards to the correct `llama-server` session (see
  `src-tauri/src/core/server/proxy.rs`).

## Troubleshooting

- **`400 Missing 'model' query parameter`** on metrics — set `ATOMIC_MODEL`
  to the exact `model_id` shown in Settings → Providers → llamacpp → Models.
- **`404 No running llama.cpp session for model 'X'`** — load the model in
  the app first (open a chat with it once), or check that Atomic-Chat is
  actually running with the llama.cpp provider active.
- **`401 Unauthorized`** — set `ATOMIC_API_KEY` to the token shown in
  Settings → Local API Server.
- **`server metrics: unavailable`** in the dashboard footer — Concurrent
  Mode or Expose Prometheus /metrics is off. Toggle it in the provider
  settings and restart the model.
