# Jan - Open-source ChatGPT replacement

The easiest way to get started is by downloading one of the following versions for your respective operating system:

<table>
  <tr>
    <td><b>Platform</b></td>
    <td><b>Download</b></td>
  </tr>
  <tr>
    <td><b>Windows</b></td>
    <td><a href='https://app.jan.ai/download/latest/win-x64'>jan.exe</a></td>
  </tr>
  <tr>
    <td><b>macOS</b></td>
    <td><a href='https://app.jan.ai/download/latest/mac-universal'>jan.dmg</a></td>
  </tr>
</table>


Download from [jan.ai](https://jan.ai/) or [GitHub Releases](https://github.com/janhq/jan/releases).

## Features

- **Local AI Models**: Download and run LLMs (Llama, Gemma, Qwen, GPT-oss etc.) from HuggingFace
- **Cloud Integration**: Connect to GPT models via OpenAI, Claude models via Anthropic, Mistral, Groq, MiniMax, and others
- **Custom Assistants**: Create specialized AI assistants for your tasks
- **OpenAI-Compatible API**: Local server at `localhost:1337` for other applications
- **Model Context Protocol**: MCP integration for agentic capabilities
- **Privacy First**: Everything runs locally when you want it to

## Build from Source

For those who enjoy the scenic route:

### Prerequisites

- Node.js ≥ 20.0.0
- Yarn ≥ 4.5.3
- Make ≥ 3.81
- Rust (for Tauri)
- (macOS Apple Silicon only) MetalToolchain `xcodebuild -downloadComponent MetalToolchain`

### Run with Make

```bash
git clone https://github.com/AtomicBot-ai/Atomic-Chat.git
cd jan
make dev
```

This handles everything: installs dependencies, builds core components, and launches the app.

**Available make targets:**
- `make dev` - Full development setup and launch
- `make build` - Production build
- `make test` - Run tests and linting
- `make clean` - Delete everything and start fresh

### Manual Commands

```bash
yarn install
yarn build:tauri:plugin:api
yarn build:core
yarn build:extensions
yarn dev
```

## System Requirements

**Minimum specs for a decent experience:**

- **macOS**: 13.6+ (8GB RAM for 3B models, 16GB for 7B, 32GB for 13B)
- **Windows**: 10+ with GPU support for NVIDIA/AMD/Intel Arc
- **Linux**: Most distributions work, GPU acceleration available

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full spiel.

## License

Apache 2.0 - Because sharing is caring.

## Acknowledgements

Built on the shoulders of giants:

- [Llama.cpp](https://github.com/ggerganov/llama.cpp)
- [Tauri](https://tauri.app/)
- [Scalar](https://github.com/scalar/scalar)
