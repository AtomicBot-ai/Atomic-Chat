# MLX Server

A high-performance inference server for MLX models on Apple Silicon, providing
an OpenAI-compatible HTTP API.

The backend is a **Python service** built on top of
[`AtomicBot-ai/dflash`](https://github.com/AtomicBot-ai/dflash) (`dflash.server`)
— a fork of [`z-lab/dflash`](https://github.com/z-lab/dflash) — with optional
**DFlash speculative decoding** for accelerated generation when a compatible
draft model is supplied.

## Features

- **OpenAI-Compatible API** — drop-in replacement for OpenAI Chat Completions
- **Streaming** — Server-Sent Events for real-time token streaming
- **Tool Calling** — function calls in OpenAI format (Qwen, Hermes, Llama 3.1
  and Mistral templates supported)
- **DFlash Speculative Decoding** — optional block-diffusion drafting via a
  `--draft-model` for higher tokens/sec on supported targets
- **Cancellable generation** — `POST /v1/cancel` aborts the active request

## Requirements

- macOS 14.0+ (Sonoma or later)
- Apple Silicon (M1, M2, M3, M4, M5)
- Python 3.10+
- At least 8 GB of unified memory (more for larger models)

## Installation

The backend lives in the [`AtomicBot-ai/dflash`](https://github.com/AtomicBot-ai/dflash)
repository. Install the `server` extra (it pulls in `mlx`, `mlx-lm`,
`starlette`, `uvicorn`, and `httpx`):

```bash
git clone https://github.com/AtomicBot-ai/dflash.git
cd dflash
pip install -e ".[server]"
```

> Use a dedicated virtual environment to avoid clashing with other DFlash
> backends (`transformers`, `vllm`, `sglang`).

## Quick Start

### Plain MLX inference

```bash
python -m dflash.server \
  --model /path/to/mlx-model \
  --port 8080
```

### With DFlash speculative decoding

Provide a DFlash draft model that matches the target. Example for Qwen3.5-4B:

```bash
python -m dflash.server \
  --model Qwen/Qwen3.5-4B \
  --draft-model z-lab/Qwen3.5-4B-DFlash \
  --block-size 16 \
  --port 8080
```

A list of supported target/draft pairs is published in the
[DFlash README](https://github.com/AtomicBot-ai/dflash#supported-models).

## Command-Line Options

| Option           | Default    | Description                                                              |
|------------------|------------|--------------------------------------------------------------------------|
| `-m, --model`    | _required_ | Path to MLX model directory or HuggingFace model ID (target model)       |
| `--draft-model`  | `""`       | Path or HF ID of a DFlash draft model — enables speculative decoding     |
| `--block-size`   | `0`        | DFlash block size; `0` uses the draft model's configured default         |
| `--port`         | `8080`     | HTTP server port (binds to `127.0.0.1`)                                  |
| `--ctx-size`     | `4096`     | Context window size                                                      |
| `--api-key`      | `""`       | Bearer token for authentication (optional)                               |
| `--model-id`     | `""`       | Model ID reported by `/v1/models` (defaults to target model dir name)    |

## API Endpoints

### Chat Completions

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model",
    "messages": [
      {"role": "system", "content": "You are a helpful assistant."},
      {"role": "user", "content": "Hello, how are you?"}
    ],
    "temperature": 0.7,
    "max_tokens": 100
  }'
```

### Streaming Response

```bash
curl -X POST http://localhost:8080/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "model",
    "messages": [{"role": "user", "content": "Tell me a story."}],
    "stream": true
  }'
```

### Tool Calling

`tools` and `tool_choice` follow the OpenAI schema. The server applies the
target tokenizer's chat template (forwarding `tools` when supported) and
extracts `<tool_call>...</tool_call>`, `<|python_tag|>` or `[TOOL_CALLS]`
spans into proper OpenAI `tool_calls` entries.

### Reasoning Control (Qwen3 / GLM-4.5)

Pass per-render template knobs via `chat_template_kwargs`:

```json
{
  "chat_template_kwargs": { "enable_thinking": false }
}
```

Templates that don't recognise the kwarg are retried without it
automatically.

### Cancel Active Generation

```bash
curl -X POST http://localhost:8080/v1/cancel
```

### List Models

```bash
curl http://localhost:8080/v1/models
```

### Health Check

```bash
curl http://localhost:8080/health
```

## Architecture

### Core Components

1. **`dflash.server`** — Starlette + uvicorn HTTP server with OpenAI-compatible
   endpoints (`/v1/chat/completions`, `/v1/models`, `/v1/cancel`, `/health`).
2. **Target model** — loaded via `mlx_lm.load`.
3. **DFlash draft model** *(optional)* — loaded via
   `dflash.model_mlx.load_draft`. When present, generation routes through
   `dflash.model_mlx.stream_generate`, otherwise the server falls back to
   `mlx_lm.stream_generate`.
4. **Tool-call parser** — recognises Qwen XML, Qwen JSON, Hermes
   `<|tool_call|>`, Llama `<|python_tag|>` and Mistral `[TOOL_CALLS]` formats.

### Notes

- The server binds to `127.0.0.1` (localhost only) for security.
- A client disconnect sets the cancel event and aborts in-flight generation.
- Streaming holds back partial tool-call marker prefixes so the client never
  observes a leaked `<tool_…` fragment.

## Troubleshooting

### Model Loading Fails

Ensure the target model directory contains:

- `config.json` — model configuration
- `tokenizer.json` — tokenizer vocabulary
- `model.safetensors` or `model.safetensors.index.json` — model weights
- Optional: `generation_config.json`, `chat_template.jinja`

### DFlash Draft Model Mismatch

The draft must be trained against the chosen target. Use a published pair
from the [DFlash supported-models table](https://github.com/AtomicBot-ai/dflash#supported-models)
or omit `--draft-model` to disable speculative decoding.

### Port Already in Use

```bash
--port 8081
```

## Benchmarking

Use the bundled DFlash benchmark harness:

```bash
python -m dflash.benchmark --backend mlx \
  --model Qwen/Qwen3.5-4B \
  --draft-model z-lab/Qwen3.5-4B-DFlash \
  --dataset gsm8k --max-samples 128 --enable-thinking
```

Or the
[mlx-lm server benchmark script](https://github.com/ml-explore/mlx-lm/blob/main/benchmarks/server_benchmark.py)
against the running HTTP endpoint:

```bash
python server_benchmark.py --url http://localhost:8080/v1/chat/completions --model model
```

## License

This project is part of Jan — an open-source desktop AI application.

## Resources

- [AtomicBot-ai/dflash](https://github.com/AtomicBot-ai/dflash) — backend
  source (this is the package the server is shipped from)
- [z-lab/dflash](https://github.com/z-lab/dflash) — upstream DFlash project
- [MLX](https://github.com/ml-explore/mlx) and [mlx-lm](https://github.com/ml-explore/mlx-lm)
- [OpenAI Chat Completions API](https://platform.openai.com/docs/api-reference/chat)
