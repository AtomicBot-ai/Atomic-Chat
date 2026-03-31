<img src="https://github.com/AtomicBot-ai/Atomic-Chat/raw/main/assets/logo.png" width="80" alt="Atomic Chat" />

# Atomic Chat

Open-source ChatGPT alternative. Run local LLMs or connect cloud models — with full control and privacy.

<a href="https://github.com/AtomicBot-ai/Atomic-Chat/stargazers"><img src="https://img.shields.io/github/stars/AtomicBot-ai/Atomic-Chat?style=flat&logo=github&label=Stars&color=f5c542" alt="Stars" /></a>&nbsp;
<a href="https://github.com/AtomicBot-ai/Atomic-Chat/network/members"><img src="https://img.shields.io/github/forks/AtomicBot-ai/Atomic-Chat?style=flat&logo=github&label=Forks&color=4ac1f2" alt="Forks" /></a>&nbsp;
<a href="https://github.com/AtomicBot-ai/Atomic-Chat/commits/main"><img src="https://img.shields.io/github/last-commit/AtomicBot-ai/Atomic-Chat?style=flat&label=Last%20Commit&color=blueviolet" alt="Last Commit" /></a>&nbsp;
<img src="https://img.shields.io/badge/Built_with-Tauri-FFC131?style=flat&logo=tauri&logoColor=white" alt="Tauri" />&nbsp;
<img src="https://img.shields.io/badge/Runtime-Node.js_≥20-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js" />

[Getting Started](https://atomic.chat/) · [Discord](https://discord.com/invite/AbWHHdKT) · [X / Twitter](https://x.com/atomic_chat_hq) · [Bug Reports](https://github.com/AtomicBot-ai/Atomic-Chat/issues)

<p align="center">
  <img src="https://github.com/AtomicBot-ai/Atomic-Chat/raw/main/assets/preview.png" width="100%" alt="Atomic Chat Interface" />
</p>

---

### Download

|                       |                                                                          |
| --------------------- | ------------------------------------------------------------------------ |
| **macOS (Universal)** | [atomic-chat.dmg](https://github.com/AtomicBot-ai/Atomic-Chat/releases/tag/v1.0.23) |

Download from [atomic.chat](https://atomic.chat/) or [GitHub Releases](https://github.com/AtomicBot-ai/Atomic-Chat/releases).

---

### Features

- 🧠 **Local AI Models** — download and run LLMs (Llama, Gemma, Qwen, and more) from HuggingFace
- ☁️ **Cloud Integration** — connect to OpenAI, Anthropic, Mistral, Groq, MiniMax, and others
- 🤖 **Custom Assistants** — create specialized AI assistants for your tasks
- 🔌 **OpenAI-Compatible API** — local server at `localhost:1337` for other applications
- 🔗 **Model Context Protocol** — MCP integration for agentic capabilities
- 🔒 **Privacy First** — everything runs locally when you want it to

---

### Build from Source

#### Prerequisites

- Node.js ≥ 20.0.0
- Yarn ≥ 4.5.3
- Make ≥ 3.81
- Rust (for Tauri)
- (Apple Silicon) MetalToolchain `xcodebuild -downloadComponent MetalToolchain`

#### Run with Make

```bash
git clone https://github.com/AtomicBot-ai/Atomic-Chat
cd Atomic-Chat
make dev
```

This handles everything: installs dependencies, builds core components, and launches the app.

**Available make targets:**

- `make dev` — full development setup and launch
- `make build` — production build
- `make test` — run tests and linting
- `make clean` — delete everything and start fresh

#### Manual Commands

```bash
yarn install
yarn build:tauri:plugin:api
yarn build:core
yarn build:extensions
yarn dev
```

---

### System Requirements

- **macOS**: 13.6+ (8GB RAM for 3B models, 16GB for 7B, 32GB for 13B)

---

### Troubleshooting

If something isn't working:

1. Copy your error logs and system specs
2. Open an issue on [GitHub](https://github.com/AtomicBot-ai/Atomic-Chat/issues)
3. Or ask for help in our [Discord](https://discord.com/invite/AbWHHdKT) `#🆘|atomic-chat-help` channel

---

### Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for details.

<p align="center">
  <a href="https://discord.com/invite/AbWHHdKT"><img src="https://img.shields.io/badge/💬_Chat_on-Discord-5865F2?style=for-the-badge&logo=discord&logoColor=white" alt="Discord" /></a>&nbsp;
  <a href="https://github.com/AtomicBot-ai/Atomic-Chat/issues"><img src="https://img.shields.io/badge/🐛_Report-Issues-FF4444?style=for-the-badge" alt="Report Issues" /></a>&nbsp;
  <a href="https://github.com/AtomicBot-ai/Atomic-Chat/pulls"><img src="https://img.shields.io/badge/🔀_Submit-PRs-44CC11?style=for-the-badge" alt="Submit PRs" /></a>
</p>

---

### Contact

- **Bugs**: [GitHub Issues](https://github.com/AtomicBot-ai/Atomic-Chat/issues)
- **General Discussion**: [Discord](https://discord.com/invite/AbWHHdKT)
- **Updates**: [X / Twitter](https://x.com/atomic_chat_hq)

---

### License

Apache 2.0 — see [LICENSE](LICENSE) for details.

### Acknowledgements

Built on the shoulders of giants:

- [Llama.cpp](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant)
- [Tauri](https://tauri.app/)
- [Scalar](https://github.com/scalar/scalar)

---

<p align="center">
  <sub>© 2026 Atomic Chat · Built with ❤️ · <a href="https://atomic.chat">atomic.chat</a></sub>
</p>
