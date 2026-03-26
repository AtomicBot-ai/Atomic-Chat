# Atomic Chat - Open-source ChatGPT replacement

<p align="center">
  <img width="128" height="128" alt="Atomic Chat logo" src="web-app/public/images/atomic-chat-logo.png" />
</p>

<p align="center">
  <!-- ALL-CONTRIBUTORS-BADGE:START - Do not remove or modify this section -->
  <img alt="GitHub commit activity" src="https://img.shields.io/github/commit-activity/m/AtomicBot-ai/Atomic-Chat"/>
  <img alt="Github Last Commit" src="https://img.shields.io/github/last-commit/AtomicBot-ai/Atomic-Chat"/>
  <img alt="Github Contributors" src="https://img.shields.io/github/contributors/AtomicBot-ai/Atomic-Chat"/>
  <img alt="GitHub closed issues" src="https://img.shields.io/github/issues-closed/AtomicBot-ai/Atomic-Chat"/>
  <img alt="Discord" src="https://img.shields.io/discord/1107178041848909847?label=discord"/>
</p>

<p align="center">
  <a href="https://atomic.chat/docs/desktop">Getting Started</a>
  - <a href="https://discord.gg/Exe46xPMbK">Community</a>
  - <a href="https://atomic.chat/changelog">Changelog</a>
  - <a href="https://github.com/AtomicBot-ai/Atomic-Chat/issues">Bug reports</a>
</p>

Atomic Chat is bringing the best of open-source AI in an easy-to-use product. Download and run LLMs with **full control** and **privacy**.

## Installation

<p align="center">
  <table>
    <tr>
      <!-- Microsoft Store Badge -->
      <td align="center" valign="middle">
        <a href="https://apps.microsoft.com/detail/xpdcnfn5cpzlqb">
          <img height="60"
            width="200"
               alt="Get it from Microsoft Store"
               src="https://get.microsoft.com/images/en-us%20dark.svg"/>
        </a>
      </td>
      <!-- Spacer -->
      <td width="20"></td>
      <!-- Flathub Official Badge -->
      <td align="center" valign="middle">
        <a href="https://flathub.org/apps/chat.atomic.AtomicChat">
          <img height="60"
            width="200"
               alt="Get it on Flathub"
               src="https://flathub.org/assets/badges/flathub-badge-en.svg"/>
        </a>
      </td>
    </tr>
  </table>
</p>

The easiest way to get started is by downloading one of the following versions for your respective operating system:

<table>
  <tr>
    <td><b>Platform</b></td>
    <td><b>Download</b></td>
  </tr>
  <tr>
    <td><b>Windows</b></td>
    <td><a href='https://app.atomic.chat/download/latest/win-x64'>atomic-chat.exe</a></td>
  </tr>
  <tr>
    <td><b>macOS</b></td>
    <td><a href='https://app.atomic.chat/download/latest/mac-universal'>atomic-chat.dmg</a></td>
  </tr>
  <tr>
    <td><b>Linux (deb)</b></td>
    <td><a href='https://app.atomic.chat/download/latest/linux-amd64-deb'>atomic-chat.deb</a></td>
  </tr>
  <tr>
    <td><b>Linux (AppImage)</b></td>
    <td><a href='https://app.atomic.chat/download/latest/linux-amd64-appimage'>atomic-chat.AppImage</a></td>
  </tr>
  <tr>
    <td><b>Linux (Arm64)</b></td>
    <td><a href='https://github.com/AtomicBot-ai/Atomic-Chat/issues/4543#issuecomment-3734911349'>How-to</a></td>
  </tr>
</table>


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
- (macOS Apple Silicon only) MetalToolchain `xcodebuild -downloadComponent MetalToolchain`

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
- **Windows**: 10+ with GPU support for NVIDIA/AMD/Intel Arc
- **Linux**: Most distributions work, GPU acceleration available

For detailed compatibility, check our [installation guides](https://atomic.chat/docs/desktop/mac).

## Troubleshooting

If things go sideways:

1. Check our [troubleshooting docs](https://atomic.chat/docs/desktop/troubleshooting)
2. Copy your error logs and system specs
3. Ask for help in our [Discord](https://discord.gg/FTk2MvZwJH) `#🆘|atomic-chat-help` channel


## Contributing

Contributions welcome. See [CONTRIBUTING.md](CONTRIBUTING.md) for the full spiel.

## Links

- [Documentation](https://atomic.chat/docs) - The manual you should read
- [API Reference](https://atomic.chat/api-reference) - For the technically inclined
- [Changelog](https://atomic.chat/changelog) - What we broke and fixed
- [Discord](https://discord.gg/FTk2MvZwJH) - Where the community lives

## Contact

- **Bugs**: [GitHub Issues](https://github.com/AtomicBot-ai/Atomic-Chat/issues)
- **Business**: hello@atomic.chat
- **Jobs**: hr@atomic.chat
- **General Discussion**: [Discord](https://discord.gg/FTk2MvZwJH)

## License

Apache 2.0 - Because sharing is caring.

## Acknowledgements

Built on the shoulders of giants:

- [Llama.cpp](https://github.com/ggerganov/llama.cpp)
- [Tauri](https://tauri.app/)
- [Scalar](https://github.com/scalar/scalar)
