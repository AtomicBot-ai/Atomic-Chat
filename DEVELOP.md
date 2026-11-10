# Running and developing Atomic Chat reliably

## What happened in the log

1. **Vite/esbuild errors** (`The service was stopped` / `The service is no longer running`) appeared **after you closed the Atomic Chat window**. Closing the app ends the `cargo run` process → the whole `yarn dev` ends → the child Vite process stops. While stopping, Vite still tries to handle requests (HMR, etc.) and reports that the service is no longer running. This is not a code bug, just a consequence of the dev process shutting down.

2. **Icons are generated on every launch** — the `dev:tauri` script calls `yarn build:icon` every time. This is by design in the project and adds a few seconds to startup.

3. **Rust gets rebuilt** — on the first launch after changes, cargo does an incremental build (~13–40 s). Without Rust changes the build is almost instant.

---

## How to run reliably

### Isolated QA/dev profile

To check the first-run flow without reading or changing your usual profile,
quit Atomic Chat and start it with an absolute directory in
`ATOMIC_CHAT_PROFILE_DIR`. Nothing else needs redirecting (no
`CFFIXED_USER_HOME` or `HOME`):

- Settings live in `<profile>/settings.json` and data in `<profile>/data`; the
  legacy Atomic Chat/Jan directories are not used in this mode. The app hands
  `<profile>/data` to the core it starts (`--data-folder`).
- The main window's webview storage (localStorage, IndexedDB, cookies, caches)
  belongs to the profile too. It holds projects, onboarding progress and
  frontend settings, so a new profile starts with onboarding and with empty
  Projects and Recents. On Windows and Linux it is `<profile>/webview`. On
  macOS WebKit keeps it outside the profile, as
  `~/Library/WebKit/<bundle id or executable name>/WebsiteDataStore/<id>`,
  where `<id>` is the UUID in `<profile>/webview-store-id`. A profile folder
  deleted and created again at the same path gets a new, empty store; the old
  one stays in `~/Library/WebKit` until you delete it.

```bash
ATOMIC_CHAT_PROFILE_DIR=/tmp/atomic-chat-clean-flow yarn dev
```

What the profile does not cover:

- **One Atomic Chat at a time.** The single-instance lock is named after the
  bundle identifier, not the profile: a launch while any Atomic Chat runs
  hands over to it and exits, so quit the usual app first, and two profiles
  cannot run side by side. The identifier stays the same because the
  window-state file, the updater session, the MCP lock files and the default
  WebView2/WebKitGTK folder are all named after it.
- **Shared with the usual app:** window size and position, the updater
  session and the MCP lock files (all in the identifier-named app directories),
  and the operating system's launch-at-login item.
- **Secondary windows** (App Logs, System Monitor, Local API Server Logs) are
  opened by the frontend through Tauri's own window API, which cannot set a
  data store, so they still read the usual webview storage (theme and
  interface settings).
- **macOS 13 and earlier** have no per-profile WebKit stores: the main window
  falls back to the usual webview storage there.

The CLI is the core's and does not read the variable: give it a folder of its
own (it refuses the app's data folder), for example
`bun run ../atomic-chat-core/src/cli/bin.ts --data-folder /tmp/atomic-chat-clean-cli --help`.

The variable is meant for QA and development only. An empty or relative value,
or one containing `..`, is ignored and the app uses the usual profile.

### One terminal, one process

```bash
cd /Users/max/Desktop/desc-app/jan
yarn dev
```

- Wait for `Running target/debug/Atomic Chat` in the log and for the Atomic Chat window to appear.
- **Do not close this terminal**, and if possible **do not close the Atomic Chat window** while developing.
- Edit code in `web-app/` — Vite picks up the changes (hot reload), no restart needed.
- When you edit Rust in `src-tauri/`, Tauri rebuilds and restarts the app on save.

**When you are done:** close the Atomic Chat window, then press **Ctrl+C** once in the terminal. That way both Vite and Tauri shut down predictably, without extra messages about a stopped service.

---

## Routine for every time you sit down to work

1. Open a terminal.
2. `cd /Users/max/Desktop/desc-app/jan`
3. `yarn dev`
4. Wait for the Atomic Chat window to open.
5. Work on the frontend in `web-app/` or the backend in `src-tauri/`.
6. At the end: close the Atomic Chat window → **Ctrl+C** in the terminal.

To run again, just `yarn dev` (no `make dev`), as long as you have not changed dependencies or run `make clean`.

---

## What to edit where

| Task | Where the code is |
|--------|--------|
| UI, screens, components | `web-app/src/` |
| Extension logic, core (TypeScript) | `core/`, `extensions/` |
| Native API, plugins, CLI | `src-tauri/` (Rust) |

After changes in **web-app** no restart is needed — hot reload kicks in. After changes in **Rust**, Tauri rebuilds and restarts the app on its own.

---

## If something goes wrong

- **"The service is no longer running"** — usually means the process has already exited (the window was closed or Ctrl+C was pressed). Just run `yarn dev` again.
- **The window does not open / hangs** — make sure port 1420 is free (`lsof -i :1420`), kill old processes and run `yarn dev` again.
- **After switching branches or pulling** — if needed, run `make dev` once (full install and build), then go back to just `yarn dev`.
- **A new `src-tauri/.env` is ignored** — the build script watches that file only while it exists, so after creating it run `touch src-tauri/build.rs` once; edits to an existing `.env` are picked up on their own.

---

## Where Atomic Chat stores data on Windows

Dev (`make dev-windows-cpu` / `yarn dev`) and the installed `Atomic Chat.exe` **share the same data folders** — there is no separate dev profile. Anything you delete from these paths affects both.

| Path | Contents | Cleared by |
|---|---|---|
| `%APPDATA%\Atomic Chat\data\llamacpp-upstream\backends\` | Downloaded llama.cpp backend builds (CPU / CUDA 12.4 / CUDA 13.1 / Vulkan), sourced from `ggml-org/llama.cpp`. Active path on Windows since ADR 2026-05-22 *Windows ships only `llamacpp-upstream`*. | `make dev-windows-cpu`, `make clean-windows-all`, uninstaller (Delete app data) |
| `%APPDATA%\Atomic Chat\data\llamacpp\backends\` | **Legacy** (pre-2026-05-22) turboquant `llamacpp` backends. Left orphaned on existing installs and ignored by the Windows app; safe to delete manually. Models under `data\llamacpp\models\` are still active (shared root). | manual delete, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\models\` | Downloaded GGUF / MLX models | factory reset (UI), `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\threads\` | Chat history | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\diffusion\backends\` | Downloaded `stable-diffusion.cpp` (`sd-server`) builds, one tree per tag and backend id, sourced from `leejet/stable-diffusion.cpp` via `atomic-chat-conf/backends/sdcpp-manifest.json`. Trees carry an `.atomic-owned` marker. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\diffusion\models\` | Image-generation checkpoints (`<family>\*.gguf`) and shared side files (`shared\<repo>\`: VAE, text encoders). Deliberately outside `models\` so the hub and the local-model scanner never list them. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\audio\backends\` | Downloaded `audio.cpp` (`audiocpp_server`) builds, installed by the core from `atomic-chat-conf/backends/audiocpp-manifest.json`, one tree per tag and backend id, with an `.atomic-owned` marker. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\audio\models\` | Audio models, one GGUF per catalog quant, named by the `audio` collection of `atomic-chat-conf/models/catalog.json`. Outside `models\` for the same reason as the image checkpoints. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\audios\` | The Audios gallery: `<jobId>.wav` beside its `<jobId>.json` recipe. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\images\` | Generated images (`<jobId>-<nn>.png` with the recipe in a PNG `tEXt` chunk, `.thumb.png` beside each) and `.flags.json`. Relocatable from Settings → Media. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\extensions\` | Installed extensions (`@janhq/*`, `llamacpp-extension`, …) | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\logs\app.log` | Application logs (`tauri_plugin_log`) | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\store.json` | Migration / version store | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\mcp_config.json` | MCP servers config | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\chat.atomic.app\settings.json` | Current `AppConfiguration` (`{ data_folder: ... }`) — new installs | `make clean-windows-all`, uninstaller (Tauri default) |
| `%APPDATA%\Atomic-Chat\settings.json` | Legacy `settings.json` (only present on older installs) | `make clean-windows-all`, uninstaller |
| `%LOCALAPPDATA%\chat.atomic.app\EBWebView\` | WebView2 storage incl. `localStorage` (`setupCompleted`, `llama_cpp_pending_backend`, `llama_cpp_better_backend_recommendation`, …) | `make dev-windows-cpu` (Local Storage only), `make clean-windows-all`, uninstaller |

### Why three different APPDATA folders

`[Cargo.toml].name = "Atomic-Chat"` ≠ `productName = "Atomic Chat"` ≠ `identifier = "chat.atomic.app"`. This is intentional historical layout; renaming any of them would break user-data migrations. Just be aware that the same product writes into three sibling APPDATA directories.

### How to reset for testing

| Need | Command |
|---|---|
| Re-test the bundled CPU backend → GPU auto-download flow | `make dev-windows-cpu` (clears only `backends/` + WebView2 Local Storage + `settings.json`) |
| Full wipe (all data, settings, WebView2 cache) — true first-launch | `make clean-windows-all CONFIRM=1` |
| In-app reset (keeps downloaded backends and the active backend selection) | `Settings → General → Reset to Factory Default` |
| End-user uninstall + delete data | Uninstaller → enable **Delete app data** checkbox |

### Custom data folder

If a user has relocated the data folder via `Settings → Advanced → Change data folder location` (`change_app_data_folder`), the uninstaller and `make clean-windows-all` **do not** delete that custom path — only the default `%APPDATA%\Atomic Chat\` is cleaned. Removing a custom data folder is the user's responsibility.

## FastFlowLM desktop development

FastFlowLM is offered by core on Windows 11/Linux x64 with AMD XDNA2. macOS can run contract and frontend checks, but cannot establish desktop NPU acceptance. Production core binaries follow `package.json` → `atomicCore.version`; the public SDK is pinned to `0.22.0`.

For an unreleased core, import both binaries together; the explicit version also controls the Tauri build's handshake stamp:

```bash
ATOMIC_CORE_VERSION=<version> \
ATOMIC_CORE_LOCAL=<absolute-cli-binary> \
ATOMIC_APP_CORE_LOCAL=<absolute-app-core-binary> make download-core
```

Keep `ATOMIC_CORE_VERSION` in the process environment when building Tauri against that pair. Omit all three overrides and run `make download-core` to return to the production pin. No environment override is stored in the repository.

Use `VITE_ATOMIC_MODEL_CATALOG_URL=file://<absolute-conf-checkout>/catalog.json` for the frontend's complete shared catalog. Start the app with `ATOMIC_FASTFLOWLM_MANIFEST_URL=file://<absolute-conf-checkout>/backends/fastflowlm-manifest.json` and `ATOMIC_FASTFLOWLM_ENVIRONMENT_MANIFEST_URL=file://<absolute-environment-manifest>` for core's build/environment sources. These are development overrides; do not change production URLs. Restart Vite after changing its `VITE_` source.

The existing application data folder contains `fastflowlm/models/<variant>` for accepted model files and `fastflowlm/transfers/<variant>` for download/publication/removal journals, staging and previous copies. Resume reads the saved plan even if conf has changed. Startup recovers already persisted mutations; unfinished byte transfers return paused. Do not remove these journals to clear a busy model: they carry the maintenance request identity and may protect the previous valid installation.

The NPU preparation panel shows core's manual driver guidance. Its commands are display-only. Consent to automatic memory-limit preparation is bound to the displayed account, service, plan digest and revision. The trusted helper's original receipt is recovered after a lost response; an unknown launch is not repeated. Test actual UAC/pkexec and desktop restart/reboot on the target OS before claiming acceptance. Never use a root or shell probe as evidence for the app's runtime account.
