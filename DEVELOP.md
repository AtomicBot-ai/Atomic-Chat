# Running and developing Atomic Chat reliably

## What happened in the log

1. **Vite/esbuild errors** (`The service was stopped` / `The service is no longer running`) appeared **after you closed the Atomic Chat window**. Closing the app ends the `cargo run` process → the whole `yarn dev` ends → the child Vite process stops. While stopping, Vite still tries to handle requests (HMR, etc.) and reports that the service is no longer running. This is not a code bug, just a consequence of the dev process shutting down.

2. **Icons are generated on every launch** — the `dev:tauri` script calls `yarn build:icon` every time. This is by design in the project and adds a few seconds to startup.

3. **Rust gets rebuilt** — on the first launch after changes, cargo does an incremental build (~13–40 s). Without Rust changes the build is almost instant.

---

## How to run reliably

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

---

## Where Atomic Chat stores data on Windows

Dev (`make dev-windows-cpu` / `yarn dev`) and the installed `Atomic Chat.exe` **share the same data folders** — there is no separate dev profile. Anything you delete from these paths affects both.

| Path | Contents | Cleared by |
|---|---|---|
| `%APPDATA%\Atomic Chat\data\llamacpp-upstream\backends\` | Downloaded llama.cpp backend builds (CPU / CUDA 12.4 / CUDA 13.1 / Vulkan), sourced from `ggml-org/llama.cpp`. Active path on Windows since ADR 2026-05-22 *Windows ships only `llamacpp-upstream`*. | `make dev-windows-cpu`, `make clean-windows-all`, uninstaller (Delete app data) |
| `%APPDATA%\Atomic Chat\data\llamacpp\backends\` | **Legacy** (pre-2026-05-22) turboquant `llamacpp` backends. Left orphaned on existing installs and ignored by the Windows app; safe to delete manually. Models under `data\llamacpp\models\` are still active (shared root). | manual delete, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\models\` | Downloaded GGUF / MLX models | factory reset (UI), `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\data\threads\` | Chat history | factory reset, `make clean-windows-all`, uninstaller |
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
