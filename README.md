<img src="https://github.com/AtomicBot-ai/Atomic-Chat/raw/main/assets/logo.png" width="80" alt="Atomic Chat" />

# Atomic Chat

Local AI app and inference engine for agents. Run open-weight LLMs locally — private, on your machine.

<a href="https://github.com/AtomicBot-ai/Atomic-Chat/stargazers"><img src="https://img.shields.io/github/stars/AtomicBot-ai/Atomic-Chat?style=flat&logo=github&label=Stars&color=f5c542" alt="Stars" /></a>&nbsp;
<a href="https://github.com/AtomicBot-ai/Atomic-Chat/network/members"><img src="https://img.shields.io/github/forks/AtomicBot-ai/Atomic-Chat?style=flat&logo=github&label=Forks&color=4ac1f2" alt="Forks" /></a>&nbsp;
<a href="https://github.com/AtomicBot-ai/Atomic-Chat/graphs/contributors"><img src="https://img.shields.io/github/contributors/AtomicBot-ai/Atomic-Chat?style=flat&logo=github&label=Contributors&color=ff69b4" alt="Contributors" /></a>&nbsp;
<a href="https://github.com/AtomicBot-ai/Atomic-Chat/commits/main"><img src="https://img.shields.io/github/last-commit/AtomicBot-ai/Atomic-Chat?style=flat&label=Last%20Commit&color=blueviolet" alt="Last Commit" /></a>&nbsp;
<img src="https://img.shields.io/badge/Built_with-Tauri-FFC131?style=flat&logo=tauri&logoColor=white" alt="Tauri" />&nbsp;
<img src="https://img.shields.io/badge/Runtime-Node.js_≥20-339933?style=flat&logo=nodedotjs&logoColor=white" alt="Node.js" />

[Getting Started](https://atomic.chat/) · [Hugging Face](https://huggingface.co/AtomicChat) · [Discord](https://discord.com/invite/8wGSsvmg4V) · [X / Twitter](https://x.com/atomic_chat_hq) · [Bug Reports](https://github.com/AtomicBot-ai/Atomic-Chat/issues)

<p align="center">
  <img src="https://github.com/AtomicBot-ai/.github/raw/main/assets/0529_final.gif" width="100%" alt="Atomic Chat — local AI chat in action" />
</p>

---
### 📦 Download

<p align="left"><b>Desktop</b></p>
<p align="left">
  <a href="https://github.com/AtomicBot-ai/Atomic-Chat/releases/download/v2.0.0/Atomic.Chat_2.0.0_universal.dmg"><img src="https://img.shields.io/badge/macOS-Universal-000000?style=for-the-badge&logo=apple&logoColor=white" height="46" alt="Download for macOS" /></a>&nbsp;
  <a href="https://github.com/AtomicBot-ai/Atomic-Chat/releases/download/v2.0.0/Atomic.Chat_2.0.0_x64-setup.exe"><img src="https://img.shields.io/badge/Windows-x64-0078D4?style=for-the-badge&logo=windows11&logoColor=white" height="46" alt="Download for Windows" /></a>&nbsp;
  <a href="https://github.com/AtomicBot-ai/Atomic-Chat/releases/download/v2.0.0/Atomic.Chat_2.0.0_amd64.AppImage"><img src="https://img.shields.io/badge/Linux-AppImage-FCC624?style=for-the-badge&logo=linux&logoColor=black" height="46" alt="Download for Linux" /></a>
</p>

<p align="left"><b>Mobile</b></p>
<p align="left">
  <a href="https://apps.apple.com/us/app/atomic-chat-private-local-ai/id6761720226"><img src="https://img.shields.io/badge/iOS-App_Store-0D96F6?style=for-the-badge&logo=appstore&logoColor=white" height="46" alt="Download for iOS" /></a>&nbsp;
  <a href="https://play.google.com/store/apps/details?id=chat.atomic.app"><img src="https://img.shields.io/badge/Android-Google_Play-414141?style=for-the-badge&logo=googleplay&logoColor=white" height="46" alt="Download for Android" /></a>
</p>

---

### 🔌 Use It as an API

Atomic Chat runs an **OpenAI-compatible server at `http://localhost:1337/v1`** — a drop-in replacement for the OpenAI SDK. Load a model in the app, then point any client at it:

```bash
curl http://localhost:1337/v1/chat/completions \
  -H "Content-Type: application/json" \
  -d '{
    "model": "<model-id-loaded-in-atomic-chat>",
    "messages": [{ "role": "user", "content": "Say hello in one word" }]
  }'
```

```python
from openai import OpenAI

# Atomic Chat is OpenAI API-compatible — only the base_url changes.
client = OpenAI(base_url="http://localhost:1337/v1", api_key="not-needed")

resp = client.chat.completions.create(
    model="<model-id-loaded-in-atomic-chat>",
    messages=[{"role": "user", "content": "Say hello in one word"}],
)
print(resp.choices[0].message.content)
```

Bound to `127.0.0.1` by default; set `host: 0.0.0.0` to expose it on your LAN. Works with any agent, CLI, or IDE plugin that speaks the OpenAI API — see [Launch With](#-launch-with) below.

---

### ✨ Features

**Local models**

- Run open-weight LLMs locally from HuggingFace — Llama, Gemma, Qwen, Mistral, Phi, and others
- Multi-Token Prediction (MTP) speculative decoding — 30–70% throughput boost on supported models, up to 3× on Gemma 4
- DFlash block-diffusion decoding — up to 6× faster on Qwen 3.6, Gemma 4, Kimi K2.5
- Flash Attention toggle (`on` / `off` / `auto`)
- Automatic reasoning-context tracking for chain-of-thought models
- Auto context-window expansion with overflow notifications
- EAGLE-3 speculative decoding for Gemma 4 on Apple Silicon (MLX)
- MTP on MLX for Qwen 3.5 / 3.6 and DeepSeek V4
- TurboQuant KV cache (`turbo3` / `turbo4`) on llama.cpp — now on **Windows & Linux** too, not just macOS: up to ~4.3× smaller KV cache footprint, CPU and GPU (CUDA / Vulkan)
- TurboQuant KV cache on MLX-VLM — smaller memory footprint via RHT-correct fast paths

**Cloud models**

- Built-in providers: OpenAI, Anthropic, Mistral, Groq, MiniMax, Qwen, Moonshot
- Bring your own key, switch model per chat, mix local and cloud freely

**Tools & integrations**

- One-click agent launch — launch coding agents like Claude Code, Codex CLI, Cline, OpenCode, Droid, Goose, OpenHands, Copilot CLI, Kilo Code and Zed in one click from the Integrations tab
- Artifacts — live preview panel for HTML/CSS/JS code with copy, download and print
- Connect multiple [MCP](https://modelcontextprotocol.io/) servers — bring your own tools, file access, web search
- Custom assistants with per-assistant system prompts
- Projects with conversation tree view in the sidebar

**Local API**

- OpenAI-compatible server at `http://localhost:1337/v1` — drop-in replacement for the OpenAI SDK
- Works with any agent, CLI, or IDE plugin that speaks the OpenAI API
- Bound to `127.0.0.1` by default; set `host: 0.0.0.0` to expose on LAN

**Privacy**

- Everything runs locally when you want it to — local server is loopback-only by default
- Your conversations and keys stay on your machine

---

### ⚙️ Inference Engines

Three engines under the hood, all exposed through one OpenAI-compatible API at `http://localhost:1337/v1`:

- **[atomic-llama-cpp-turboquant](https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant)** — our `llama.cpp` fork with TurboQuant KV-cache optimizations (`turbo3` / `turbo4`) for faster, lower-memory quantized inference. Now a selectable second provider ("Atomic Llama.cpp Turboquant") on **all three desktops** — macOS, Windows, and Linux — CPU and GPU (CUDA / Vulkan).
- **Upstream [llama.cpp](https://github.com/ggml-org/llama.cpp)** — official `ggml-org` build, the default engine on Windows and Linux for the widest hardware coverage and MTP support.
- **[MLX-VLM](https://github.com/Blaizzy/mlx-vlm)** — Apple Silicon-native engine for vision-language models, running on the Neural Engine and unified memory. Faster than llama.cpp on M-series chips for supported models.

Speculative-decoding features available across backends:

- **MTP (Multi-Token Prediction)** — a draft model predicts ahead, the full model verifies in one pass. Available on macOS and Windows.
- **DFlash** — block-diffusion speculative decoding for Qwen 3.6, Gemma 4, Kimi K2.5 and others. Apple Silicon only; can't be enabled together with MTP.
- **Flash Attention** — Settings → `on` / `off` / `auto`.

Tools talking to `http://localhost:1337/v1` don't need to know which backend is running underneath — switch engines without reconfiguring clients.

---

### 🚀 Launch With

Atomic Chat runs an OpenAI-compatible server at `http://localhost:1337/v1`, so **any agent, CLI, IDE plugin, or app that speaks the OpenAI API can run on top of your local models** — no extra glue needed. Just point its base URL at Atomic Chat and you're done.

A few projects already ship first-class support with their own setup docs:

| Tool | What it is | Setup |
| --- | --- | --- |
| **[OpenCode](https://opencode.ai/)** | Open-source TUI coding agent. Add Atomic Chat as a local provider in `opencode.json`. | [Setup&nbsp;guide&nbsp;→](https://opencode.ai/docs/providers/#atomic-chat) |
| **[Goose](https://github.com/block/goose)** | Open-source extensible AI agent (CLI, desktop, API). | [Setup&nbsp;guide&nbsp;→](https://goose-docs.ai/docs/getting-started/providers/#local-llms) |
| **[nanobot](https://github.com/HKUDS/nanobot)** | Ultra-lightweight personal AI agent with chat channels, MCP, and WebUI. | [Repo&nbsp;→](https://github.com/HKUDS/nanobot) |
| **[nanoclaw](https://github.com/qwibitai/nanoclaw)** | Containerized agent runtime that calls Atomic Chat as an MCP tool. | [Skill&nbsp;guide&nbsp;→](https://github.com/qwibitai/nanoclaw/blob/main/.claude/skills/add-atomic-chat-tool/SKILL.md) |
| **[OpenClaude](https://github.com/Gitlawb/openclaude)** | Open-source coding-agent CLI for cloud and local models. Lists Atomic Chat as a supported provider. | [Providers&nbsp;list&nbsp;→](https://github.com/Gitlawb/openclaude#supported-providers) |
| **[Kilo Code](https://kilo.ai/)** | Open-source AI coding agent for VS Code, JetBrains, and CLI. Ships with first-class Atomic Chat provider support and auto-discovery. | [Setup&nbsp;guide&nbsp;→](https://kilo.ai/docs/ai-providers/atomic-chat) |
| **[Hermes Desktop](https://github.com/fathah/hermes-desktop)** | Native desktop companion for Hermes Agent. Includes an Atomic Chat local preset at `http://localhost:1337/v1`. | [Repo&nbsp;→](https://github.com/fathah/hermes-desktop) |
| **[Hermes Workspace](https://github.com/outsourc-e/hermes-workspace)** | Local-first agent workspace built on Nous Research's Hermes. Uses Atomic Chat as its inference backend. | [Repo&nbsp;→](https://github.com/outsourc-e/hermes-workspace) |

> Built something that runs on Atomic Chat? [Open a PR](https://github.com/AtomicBot-ai/Atomic-Chat/pulls) and we'll add it here.

---

### 🛠️ Build from Source

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

### 💻 System Requirements

- **macOS**: 13.6+ (8GB RAM for 3B models, 16GB for 7B, 32GB for 13B)
- **Windows**: 10/11 x64 (same RAM recommendations as macOS)
- **Linux**: x86_64, glibc ≥ 2.35 (Ubuntu 22.04+, Debian 12+, Fedora 40+, Arch, Mint, Pop!_OS — same RAM recommendations as macOS). Optional: a Vulkan loader (`vulkan-1` package, or `mesa-vulkan-drivers` / proprietary NVIDIA driver) for GPU acceleration.
- **iOS**: download from App Store
- **Android**: download from Google Play

---

### 🐧 Running on Linux

Atomic Chat ships as a single self-contained `.AppImage` — no installer, no root:

```bash
chmod +x Atomic.Chat_*_amd64.AppImage
./Atomic.Chat_*_amd64.AppImage
```

If prompted about FUSE on first launch: `sudo apt install fuse libfuse2` (Debian/Ubuntu) or `sudo dnf install fuse fuse-libs` (Fedora). GPU acceleration (Vulkan) is auto-detected on first launch; only GGUF models run on Linux.

---

### 🧯 Troubleshooting

If something isn't working:

1. Copy your error logs and system specs
2. Open an issue on [GitHub](https://github.com/AtomicBot-ai/Atomic-Chat/issues)
3. Or ask for help in our [Discord](https://discord.com/invite/8wGSsvmg4V)

---

### 👥 Contributors

Atomic Chat is built by a small core team and **140+ contributors** — including everyone who shaped the project from its earliest days. Pull requests welcome — see [CONTRIBUTING.md](CONTRIBUTING.md) for how to get started.

<a href="https://github.com/Vect0rM"><img src="https://images.weserv.nl/?url=https://github.com/Vect0rM.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Vect0rM" /></a>
<a href="https://github.com/dtorey-d"><img src="https://images.weserv.nl/?url=https://github.com/dtorey-d.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="dtorey-d" /></a>
<a href="https://github.com/danyurkin"><img src="https://images.weserv.nl/?url=https://github.com/danyurkin.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="danyurkin" /></a>
<a href="https://github.com/MaxKoshJob"><img src="https://images.weserv.nl/?url=https://github.com/MaxKoshJob.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="MaxKoshJob" /></a>
<a href="https://github.com/Albert-Atomic"><img src="https://images.weserv.nl/?url=https://github.com/Albert-Atomic.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Albert-Atomic" /></a>
<a href="https://github.com/yanalialiuk"><img src="https://images.weserv.nl/?url=https://github.com/yanalialiuk.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="yanalialiuk" /></a>
<a href="https://github.com/corevibe555"><img src="https://images.weserv.nl/?url=https://github.com/corevibe555.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="corevibe555" /></a>
<a href="https://github.com/claytonlin1110"><img src="https://images.weserv.nl/?url=https://github.com/claytonlin1110.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="claytonlin1110" /></a>
<a href="https://github.com/urmauur"><img src="https://images.weserv.nl/?url=https://github.com/urmauur.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="urmauur" /></a>
<a href="https://github.com/hohieuai"><img src="https://images.weserv.nl/?url=https://github.com/hohieuai.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="hohieuai" /></a>
<a href="https://github.com/Vanalite"><img src="https://images.weserv.nl/?url=https://github.com/Vanalite.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Vanalite" /></a>
<a href="https://github.com/Minh141120"><img src="https://images.weserv.nl/?url=https://github.com/Minh141120.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Minh141120" /></a>
<a href="https://github.com/hiento09"><img src="https://images.weserv.nl/?url=https://github.com/hiento09.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="hiento09" /></a>
<a href="https://github.com/hahuyhoang411"><img src="https://images.weserv.nl/?url=https://github.com/hahuyhoang411.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="hahuyhoang411" /></a>
<a href="https://github.com/hiro-v"><img src="https://images.weserv.nl/?url=https://github.com/hiro-v.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="hiro-v" /></a>
<a href="https://github.com/qnixsynapse"><img src="https://images.weserv.nl/?url=https://github.com/qnixsynapse.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="qnixsynapse" /></a>
<a href="https://github.com/namchuai"><img src="https://images.weserv.nl/?url=https://github.com/namchuai.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="namchuai" /></a>
<a href="https://github.com/dan-menlo"><img src="https://images.weserv.nl/?url=https://github.com/dan-menlo.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="dan-menlo" /></a>
<a href="https://github.com/freelerobot"><img src="https://images.weserv.nl/?url=https://github.com/freelerobot.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="freelerobot" /></a>
<a href="https://github.com/ramonpzg"><img src="https://images.weserv.nl/?url=https://github.com/ramonpzg.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="ramonpzg" /></a>
<a href="https://github.com/ux-han"><img src="https://images.weserv.nl/?url=https://github.com/ux-han.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="ux-han" /></a>
<a href="https://github.com/aindrajaya"><img src="https://images.weserv.nl/?url=https://github.com/aindrajaya.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="aindrajaya" /></a>
<a href="https://github.com/dinhlongviolin1"><img src="https://images.weserv.nl/?url=https://github.com/dinhlongviolin1.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="dinhlongviolin1" /></a>
<a href="https://github.com/louis-jan"><img src="https://images.weserv.nl/?url=https://github.com/louis-jan.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="louis-jan" /></a>
<a href="https://github.com/LazyYuuki"><img src="https://images.weserv.nl/?url=https://github.com/LazyYuuki.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="LazyYuuki" /></a>
<a href="https://github.com/eckartal"><img src="https://images.weserv.nl/?url=https://github.com/eckartal.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="eckartal" /></a>
<a href="https://github.com/david-menloai"><img src="https://images.weserv.nl/?url=https://github.com/david-menloai.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="david-menloai" /></a>
<a href="https://github.com/Van-QA"><img src="https://images.weserv.nl/?url=https://github.com/Van-QA.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Van-QA" /></a>
<a href="https://github.com/gau-nernst"><img src="https://images.weserv.nl/?url=https://github.com/gau-nernst.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="gau-nernst" /></a>
<a href="https://github.com/github-roushan"><img src="https://images.weserv.nl/?url=https://github.com/github-roushan.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="github-roushan" /></a>
<a href="https://github.com/tikikun"><img src="https://images.weserv.nl/?url=https://github.com/tikikun.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="tikikun" /></a>
<a href="https://github.com/markmehere"><img src="https://images.weserv.nl/?url=https://github.com/markmehere.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="markmehere" /></a>
<a href="https://github.com/samhvw8"><img src="https://images.weserv.nl/?url=https://github.com/samhvw8.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="samhvw8" /></a>
<a href="https://github.com/danielcwq"><img src="https://images.weserv.nl/?url=https://github.com/danielcwq.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="danielcwq" /></a>
<a href="https://github.com/bob-ros2"><img src="https://images.weserv.nl/?url=https://github.com/bob-ros2.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="bob-ros2" /></a>
<a href="https://github.com/dev-miro26"><img src="https://images.weserv.nl/?url=https://github.com/dev-miro26.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="dev-miro26" /></a>
<a href="https://github.com/shmutalov"><img src="https://images.weserv.nl/?url=https://github.com/shmutalov.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="shmutalov" /></a>
<a href="https://github.com/drakehere"><img src="https://images.weserv.nl/?url=https://github.com/drakehere.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="drakehere" /></a>
<a href="https://github.com/dataCenter430"><img src="https://images.weserv.nl/?url=https://github.com/dataCenter430.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="dataCenter430" /></a>
<a href="https://github.com/lugnicca"><img src="https://images.weserv.nl/?url=https://github.com/lugnicca.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="lugnicca" /></a>
<a href="https://github.com/ethanova"><img src="https://images.weserv.nl/?url=https://github.com/ethanova.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="ethanova" /></a>
<a href="https://github.com/thewulf7"><img src="https://images.weserv.nl/?url=https://github.com/thewulf7.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="thewulf7" /></a>
<a href="https://github.com/linhtran174"><img src="https://images.weserv.nl/?url=https://github.com/linhtran174.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="linhtran174" /></a>
<a href="https://github.com/avb-is-me"><img src="https://images.weserv.nl/?url=https://github.com/avb-is-me.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="avb-is-me" /></a>
<a href="https://github.com/vansangpfiev"><img src="https://images.weserv.nl/?url=https://github.com/vansangpfiev.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="vansangpfiev" /></a>
<a href="https://github.com/cmppoon"><img src="https://images.weserv.nl/?url=https://github.com/cmppoon.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="cmppoon" /></a>
<a href="https://github.com/Ssstars"><img src="https://images.weserv.nl/?url=https://github.com/Ssstars.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Ssstars" /></a>
<a href="https://github.com/fredatgithub"><img src="https://images.weserv.nl/?url=https://github.com/fredatgithub.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="fredatgithub" /></a>
<a href="https://github.com/px100"><img src="https://images.weserv.nl/?url=https://github.com/px100.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="px100" /></a>
<a href="https://github.com/sharunkumar"><img src="https://images.weserv.nl/?url=https://github.com/sharunkumar.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="sharunkumar" /></a>
<a href="https://github.com/atoz96"><img src="https://images.weserv.nl/?url=https://github.com/atoz96.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="atoz96" /></a>
<a href="https://github.com/since-2017-hub"><img src="https://images.weserv.nl/?url=https://github.com/since-2017-hub.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="since-2017-hub" /></a>
<a href="https://github.com/bytrangle"><img src="https://images.weserv.nl/?url=https://github.com/bytrangle.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="bytrangle" /></a>
<a href="https://github.com/SuperCowProducts"><img src="https://images.weserv.nl/?url=https://github.com/SuperCowProducts.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="SuperCowProducts" /></a>
<a href="https://github.com/bxdoan"><img src="https://images.weserv.nl/?url=https://github.com/bxdoan.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="bxdoan" /></a>
<a href="https://github.com/gabrielle-ong"><img src="https://images.weserv.nl/?url=https://github.com/gabrielle-ong.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="gabrielle-ong" /></a>
<a href="https://github.com/trilh-dev"><img src="https://images.weserv.nl/?url=https://github.com/trilh-dev.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="trilh-dev" /></a>
<a href="https://github.com/gary149"><img src="https://images.weserv.nl/?url=https://github.com/gary149.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="gary149" /></a>
<a href="https://github.com/DistractionRectangle"><img src="https://images.weserv.nl/?url=https://github.com/DistractionRectangle.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="DistractionRectangle" /></a>
<a href="https://github.com/marknguyen1302"><img src="https://images.weserv.nl/?url=https://github.com/marknguyen1302.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="marknguyen1302" /></a>
<a href="https://github.com/cuhong"><img src="https://images.weserv.nl/?url=https://github.com/cuhong.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="cuhong" /></a>
<a href="https://github.com/mykh-hailo"><img src="https://images.weserv.nl/?url=https://github.com/mykh-hailo.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="mykh-hailo" /></a>
<a href="https://github.com/DESU-CLUB"><img src="https://images.weserv.nl/?url=https://github.com/DESU-CLUB.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="DESU-CLUB" /></a>
<a href="https://github.com/0xgokuz"><img src="https://images.weserv.nl/?url=https://github.com/0xgokuz.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="0xgokuz" /></a>
<a href="https://github.com/new5558"><img src="https://images.weserv.nl/?url=https://github.com/new5558.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="new5558" /></a>
<a href="https://github.com/linuxid10t"><img src="https://images.weserv.nl/?url=https://github.com/linuxid10t.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="linuxid10t" /></a>
<a href="https://github.com/0rzech"><img src="https://images.weserv.nl/?url=https://github.com/0rzech.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="0rzech" /></a>
<a href="https://github.com/Kuzmich55"><img src="https://images.weserv.nl/?url=https://github.com/Kuzmich55.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Kuzmich55" /></a>
<a href="https://github.com/Crystora"><img src="https://images.weserv.nl/?url=https://github.com/Crystora.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Crystora" /></a>
<a href="https://github.com/mmngn"><img src="https://images.weserv.nl/?url=https://github.com/mmngn.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="mmngn" /></a>
<a href="https://github.com/statxc"><img src="https://images.weserv.nl/?url=https://github.com/statxc.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="statxc" /></a>
<a href="https://github.com/vikram761"><img src="https://images.weserv.nl/?url=https://github.com/vikram761.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="vikram761" /></a>
<a href="https://github.com/MrAlaminH"><img src="https://images.weserv.nl/?url=https://github.com/MrAlaminH.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="MrAlaminH" /></a>
<a href="https://github.com/Lokimorty"><img src="https://images.weserv.nl/?url=https://github.com/Lokimorty.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Lokimorty" /></a>
<a href="https://github.com/copyhold"><img src="https://images.weserv.nl/?url=https://github.com/copyhold.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="copyhold" /></a>
<a href="https://github.com/STRRL"><img src="https://images.weserv.nl/?url=https://github.com/STRRL.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="STRRL" /></a>
<a href="https://github.com/Dexterity104"><img src="https://images.weserv.nl/?url=https://github.com/Dexterity104.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Dexterity104" /></a>
<a href="https://github.com/QuentinMacheda"><img src="https://images.weserv.nl/?url=https://github.com/QuentinMacheda.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="QuentinMacheda" /></a>
<a href="https://github.com/Gri-ffin"><img src="https://images.weserv.nl/?url=https://github.com/Gri-ffin.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Gri-ffin" /></a>
<a href="https://github.com/eltociear"><img src="https://images.weserv.nl/?url=https://github.com/eltociear.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="eltociear" /></a>
<a href="https://github.com/jamesdam"><img src="https://images.weserv.nl/?url=https://github.com/jamesdam.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="jamesdam" /></a>
<a href="https://github.com/razzeee"><img src="https://images.weserv.nl/?url=https://github.com/razzeee.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="razzeee" /></a>
<a href="https://github.com/metaspartan"><img src="https://images.weserv.nl/?url=https://github.com/metaspartan.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="metaspartan" /></a>
<a href="https://github.com/locnguyen1986"><img src="https://images.weserv.nl/?url=https://github.com/locnguyen1986.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="locnguyen1986" /></a>
<a href="https://github.com/irfanpena"><img src="https://images.weserv.nl/?url=https://github.com/irfanpena.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="irfanpena" /></a>
<a href="https://github.com/cs-cat"><img src="https://images.weserv.nl/?url=https://github.com/cs-cat.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="cs-cat" /></a>
<a href="https://github.com/theproductiveprogrammer"><img src="https://images.weserv.nl/?url=https://github.com/theproductiveprogrammer.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="theproductiveprogrammer" /></a>
<a href="https://github.com/Diane0111"><img src="https://images.weserv.nl/?url=https://github.com/Diane0111.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Diane0111" /></a>
<a href="https://github.com/GenkaOk"><img src="https://images.weserv.nl/?url=https://github.com/GenkaOk.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="GenkaOk" /></a>
<a href="https://github.com/Helloyunho"><img src="https://images.weserv.nl/?url=https://github.com/Helloyunho.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Helloyunho" /></a>
<a href="https://github.com/janpio"><img src="https://images.weserv.nl/?url=https://github.com/janpio.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="janpio" /></a>
<a href="https://github.com/kamal"><img src="https://images.weserv.nl/?url=https://github.com/kamal.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="kamal" /></a>
<a href="https://github.com/Louis454545"><img src="https://images.weserv.nl/?url=https://github.com/Louis454545.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Louis454545" /></a>
<a href="https://github.com/tuananhlai"><img src="https://images.weserv.nl/?url=https://github.com/tuananhlai.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="tuananhlai" /></a>
<a href="https://github.com/MauroDruwel"><img src="https://images.weserv.nl/?url=https://github.com/MauroDruwel.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="MauroDruwel" /></a>
<a href="https://github.com/zwpaper"><img src="https://images.weserv.nl/?url=https://github.com/zwpaper.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="zwpaper" /></a>
<a href="https://github.com/Realmbird"><img src="https://images.weserv.nl/?url=https://github.com/Realmbird.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Realmbird" /></a>
<a href="https://github.com/reneleonhardt"><img src="https://images.weserv.nl/?url=https://github.com/reneleonhardt.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="reneleonhardt" /></a>
<a href="https://github.com/RONNCC"><img src="https://images.weserv.nl/?url=https://github.com/RONNCC.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="RONNCC" /></a>
<a href="https://github.com/SamPatt"><img src="https://images.weserv.nl/?url=https://github.com/SamPatt.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="SamPatt" /></a>
<a href="https://github.com/mesaugat"><img src="https://images.weserv.nl/?url=https://github.com/mesaugat.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="mesaugat" /></a>
<a href="https://github.com/0saurabh0"><img src="https://images.weserv.nl/?url=https://github.com/0saurabh0.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="0saurabh0" /></a>
<a href="https://github.com/sesajad"><img src="https://images.weserv.nl/?url=https://github.com/sesajad.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="sesajad" /></a>
<a href="https://github.com/sdhrt"><img src="https://images.weserv.nl/?url=https://github.com/sdhrt.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="sdhrt" /></a>
<a href="https://github.com/lucido-simon"><img src="https://images.weserv.nl/?url=https://github.com/lucido-simon.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="lucido-simon" /></a>
<a href="https://github.com/Haleshot"><img src="https://images.weserv.nl/?url=https://github.com/Haleshot.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Haleshot" /></a>
<a href="https://github.com/vabatista"><img src="https://images.weserv.nl/?url=https://github.com/vabatista.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="vabatista" /></a>
<a href="https://github.com/volodya-lombrozo"><img src="https://images.weserv.nl/?url=https://github.com/volodya-lombrozo.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="volodya-lombrozo" /></a>
<a href="https://github.com/ynshung"><img src="https://images.weserv.nl/?url=https://github.com/ynshung.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="ynshung" /></a>
<a href="https://github.com/cashcon57"><img src="https://images.weserv.nl/?url=https://github.com/cashcon57.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="cashcon57" /></a>
<a href="https://github.com/ddri"><img src="https://images.weserv.nl/?url=https://github.com/ddri.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="ddri" /></a>
<a href="https://github.com/hooray804"><img src="https://images.weserv.nl/?url=https://github.com/hooray804.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="hooray804" /></a>
<a href="https://github.com/ldebs"><img src="https://images.weserv.nl/?url=https://github.com/ldebs.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="ldebs" /></a>
<a href="https://github.com/oolokioo7"><img src="https://images.weserv.nl/?url=https://github.com/oolokioo7.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="oolokioo7" /></a>
<a href="https://github.com/phoval"><img src="https://images.weserv.nl/?url=https://github.com/phoval.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="phoval" /></a>
<a href="https://github.com/theishangoswami"><img src="https://images.weserv.nl/?url=https://github.com/theishangoswami.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="theishangoswami" /></a>
<a href="https://github.com/utenadev"><img src="https://images.weserv.nl/?url=https://github.com/utenadev.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="utenadev" /></a>
<a href="https://github.com/zhhanging"><img src="https://images.weserv.nl/?url=https://github.com/zhhanging.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="zhhanging" /></a>
<a href="https://github.com/mishrababhishek"><img src="https://images.weserv.nl/?url=https://github.com/mishrababhishek.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="mishrababhishek" /></a>
<a href="https://github.com/sr-albert"><img src="https://images.weserv.nl/?url=https://github.com/sr-albert.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="sr-albert" /></a>
<a href="https://github.com/gdmka"><img src="https://images.weserv.nl/?url=https://github.com/gdmka.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="gdmka" /></a>
<a href="https://github.com/deining"><img src="https://images.weserv.nl/?url=https://github.com/deining.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="deining" /></a>
<a href="https://github.com/Angelopgit"><img src="https://images.weserv.nl/?url=https://github.com/Angelopgit.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Angelopgit" /></a>
<a href="https://github.com/anebot"><img src="https://images.weserv.nl/?url=https://github.com/anebot.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="anebot" /></a>
<a href="https://github.com/B0sh"><img src="https://images.weserv.nl/?url=https://github.com/B0sh.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="B0sh" /></a>
<a href="https://github.com/chindris-mihai-alexandru"><img src="https://images.weserv.nl/?url=https://github.com/chindris-mihai-alexandru.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="chindris-mihai-alexandru" /></a>
<a href="https://github.com/EndlessLucky"><img src="https://images.weserv.nl/?url=https://github.com/EndlessLucky.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="EndlessLucky" /></a>
<a href="https://github.com/mooncool"><img src="https://images.weserv.nl/?url=https://github.com/mooncool.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="mooncool" /></a>
<a href="https://github.com/Jasper-256"><img src="https://images.weserv.nl/?url=https://github.com/Jasper-256.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Jasper-256" /></a>
<a href="https://github.com/trunghaiy"><img src="https://images.weserv.nl/?url=https://github.com/trunghaiy.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="trunghaiy" /></a>
<a href="https://github.com/niesink"><img src="https://images.weserv.nl/?url=https://github.com/niesink.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="niesink" /></a>
<a href="https://github.com/maxx-ukoo"><img src="https://images.weserv.nl/?url=https://github.com/maxx-ukoo.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="maxx-ukoo" /></a>
<a href="https://github.com/myakura"><img src="https://images.weserv.nl/?url=https://github.com/myakura.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="myakura" /></a>
<a href="https://github.com/matthewbcool"><img src="https://images.weserv.nl/?url=https://github.com/matthewbcool.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="matthewbcool" /></a>
<a href="https://github.com/MichalZem"><img src="https://images.weserv.nl/?url=https://github.com/MichalZem.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="MichalZem" /></a>
<a href="https://github.com/Marco-9456"><img src="https://images.weserv.nl/?url=https://github.com/Marco-9456.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Marco-9456" /></a>
<a href="https://github.com/eren-karakus0"><img src="https://images.weserv.nl/?url=https://github.com/eren-karakus0.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="eren-karakus0" /></a>
<a href="https://github.com/thunhuanh"><img src="https://images.weserv.nl/?url=https://github.com/thunhuanh.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="thunhuanh" /></a>
<a href="https://github.com/Fieldnote-Echo"><img src="https://images.weserv.nl/?url=https://github.com/Fieldnote-Echo.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Fieldnote-Echo" /></a>
<a href="https://github.com/Eruis2579"><img src="https://images.weserv.nl/?url=https://github.com/Eruis2579.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="Eruis2579" /></a>
<a href="https://github.com/akaMrNagar"><img src="https://images.weserv.nl/?url=https://github.com/akaMrNagar.png&w=110&h=110&fit=cover&mask=circle" width="48" height="48" alt="akaMrNagar" /></a>

---

### ⭐ Star History

<a href="https://star-history.com/#AtomicBot-ai/Atomic-Chat&Date">
  <img src="https://api.star-history.com/svg?repos=AtomicBot-ai/Atomic-Chat&type=Date&cache=1" width="100%" alt="Star History" />
</a>

---

### 📄 License

Apache 2.0 — see [LICENSE](LICENSE) for details.

### 🙏 Acknowledgements

Built on the shoulders of giants:

- [llama.cpp](https://github.com/ggml-org/llama.cpp)
- [MLX-VLM](https://github.com/Blaizzy/mlx-vlm)
- [Tauri](https://tauri.app/)
- [Scalar](https://github.com/scalar/scalar)

---

### 🌱 Heritage

Atomic Chat began as a fork of [**Jan**](https://github.com/menloresearch/jan) by [Menlo Research](https://menlo.ai/) — an excellent open-source local-AI app. We're grateful to the Jan team and its contributors for the foundation they built. Atomic Chat has since grown its own direction, engines, and roadmap, but we tip our hat to where it started. 🙏

---

<p align="center">
  <sub>© 2026 Atomic Chat · Built with ❤️ · <a href="https://atomic.chat">atomic.chat</a></sub>
</p>
