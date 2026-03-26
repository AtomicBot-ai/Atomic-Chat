# Atomic Chat - Open-source ChatGPT replacement

[Getting Started](https://atomic.chat/docs/desktop) - [Discord](https://discord.gg/AbWHHdKT) - [X / Twitter](https://x.com/atomic_chat_hq) - [Bug reports](https://github.com/AtomicBot-ai/Atomic-Chat/issues)

Atomic Chat is bringing the best of open-source AI in an easy-to-use product. Download and run LLMs with **full control** and **privacy**.

The easiest way to get started is to download the macOS version:


|                       |                                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| **Platform**          | **Download**                                                             |
| **macOS (Universal)** | [atomic-chat.dmg](https://app.atomic.chat/download/latest/mac-universal) |


Download from [atomic.chat](https://atomic.chat/) or [GitHub Releases](https://github.com/AtomicBot-ai/Atomic-Chat/releases).

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
- (Apple Silicon) MetalToolchain `xcodebuild -downloadComponent MetalToolchain`

### Run with Make

```bash
git clone https://github.com/AtomicBot-ai/Atomic-Chat
cd Atomic-Chat
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

For detailed compatibility, check our [installation guides](https://atomic.chat/docs/desktop/mac).

## Troubleshooting

If things go sideways:

1. Check our [troubleshooting docs](https://atomic.chat/docs/desktop/troubleshooting)
2. Copy your error logs and system specs
3. Ask for help in our [Discord](https://discord.gg/AbWHHdKT) `#🆘|atomic-chat-help` channel

## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full spiel.

## Links

- [Discord](https://discord.gg/AbWHHdKT) - Where the community lives
- [X / Twitter](https://x.com/atomic_chat_hq) - Follow for updates

## Contact

- **Bugs**: [GitHub Issues](https://github.com/AtomicBot-ai/Atomic-Chat/issues)
- **General Discussion**: [Discord](https://discord.gg/AbWHHdKT)
- **Updates**: [X / Twitter](https://x.com/atomic_chat_hq)

## License

Apache 2.0 - Because sharing is caring.

## Acknowledgements

Built on the shoulders of giants:

- [Llama.cpp](https://github.com/ggerganov/llama.cpp)
- [Tauri](https://tauri.app/)
- [Scalar](https://github.com/scalar/scalar)

