# Стабильный запуск и доработка Radium

## Что произошло в логе

1. **Ошибки Vite/esbuild** (`The service was stopped` / `The service is no longer running`) появились **после того, как ты закрыл окно Radium**. При закрытии приложения завершается процесс `cargo run` → завершается весь `yarn dev` → останавливается дочерний Vite. В момент остановки Vite ещё успевает попытаться обработать запросы (HMR и т.д.) и пишет, что сервис уже не запущен. Это не баг кода, а следствие остановки dev-процесса.

2. **Иконки генерируются при каждом запуске** — скрипт `dev:tauri` каждый раз вызывает `yarn build:icon`. Так задумано в проекте, добавляет несколько секунд к старту.

3. **Rust пересобирается** — при первом после изменений запуске cargo делает инкрементальную сборку (~13–40 с). Без изменений в Rust сборка почти мгновенная.

---

## Как запускать стабильно

### Один терминал, один процесс

```bash
cd /Users/max/Desktop/desc-app/jan
yarn dev
```

- Дождись в логе: `Running target/debug/Atomic Chat` и появления окна Radium.
- **Не закрывай этот терминал** и по возможности **не закрывай окно Radium** во время разработки.
- Редактируй код в `web-app/` — Vite подхватит изменения (hot reload), перезапуск не нужен.
- Редактируешь Rust в `src-tauri/` — после сохранения Tauri сам пересоберёт и перезапустит приложение.

**Когда закончил работу:** закрой окно Radium, затем в терминале нажми **Ctrl+C** один раз. Так и Vite, и Tauri завершатся предсказуемо, без лишних сообщений об остановленном сервисе.

---

## Порядок при каждом «приходе за компьютер»

1. Открыть терминал.
2. `cd /Users/max/Desktop/desc-app/jan`
3. `yarn dev`
4. Дождаться открытия окна Radium.
5. Дорабатывать фронт в `web-app/` или бэкенд в `src-tauri/`.
6. В конце: закрыть окно Radium → в терминале **Ctrl+C**.

Повторный запуск — снова только `yarn dev` (без `make dev`), если не менял зависимости и не делал `make clean`.

---

## Что где править

| Задача | Где код |
|--------|--------|
| UI, экраны, компоненты | `web-app/src/` |
| Логика расширений, ядро (TypeScript) | `core/`, `extensions/` |
| Нативное API, плагины, CLI | `src-tauri/` (Rust) |

После правок в **web-app** перезапуск не нужен — сработает hot reload. После правок в **Rust** Tauri сам пересоберёт и перезапустит приложение.

---

## Если что-то пошло не так

- **«The service is no longer running»** — обычно значит, что процесс уже завершён (закрыли окно или нажали Ctrl+C). Просто заново запусти `yarn dev`.
- **Окно не открывается / зависает** — убедись, что порт 1420 свободен (`lsof -i :1420`), заверши старые процессы и снова `yarn dev`.
- **После смены ветки или pull** — при необходимости выполни `make dev` один раз (полная установка и сборка), дальше снова только `yarn dev`.

---

## Every build gets a new version number

A standing rule from the user (tracker D34, Task 27): every build of Radium that
is committed, pushed and compiled carries a new version number, so no two
different installers ever share one.

1. **Bump before you build.** Run `make bump-version` (or
   `node scripts/bump-version.mjs`). It adds one to the last number
   (2.0.37 → 2.0.38) in `src-tauri/tauri.conf.json` and
   `web-app/package.json` together. `VERSION=x.y.z make bump-version` sets a
   number instead; it must be newer, because the Windows installer only
   upgrades forwards.
2. **Commit and push the bump**, then start the build.
3. **The Windows test build enforces it.** It refuses to start when its
   version was already built from a different commit, names the installer
   `radium-windows-test-<version>-<sha>`, and tags the commit it built as
   `test-build/v<version>`.

Tell the user the new version number together with the download link.

## Where Radium stores data on Windows

Dev (`make dev-windows-cpu` / `yarn dev`) and the installed Radium app (`Atomic-Chat.exe`) **share the same data folders** — there is no separate dev profile. Anything you delete from these paths affects both.

| Path | Contents | Cleared by |
|---|---|---|
| `%APPDATA%\Radium\data\llamacpp-upstream\backends\` | Downloaded llama.cpp backend builds (CPU / CUDA 12.4 / CUDA 13.1 / Vulkan), sourced from `ggml-org/llama.cpp`. Active path on Windows since ADR 2026-05-22 *Windows ships only `llamacpp-upstream`*. | `make dev-windows-cpu`, `make clean-windows-all`, uninstaller (Delete app data) |
| `%APPDATA%\Radium\data\llamacpp\backends\` | **Legacy** (pre-2026-05-22) turboquant `llamacpp` backends. Left orphaned on existing installs and ignored by the Windows app; safe to delete manually. Models under `data\llamacpp\models\` are still active (shared root). | manual delete, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\models\` | Downloaded GGUF / MLX models | factory reset (UI), `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\threads\` | Chat history | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\extensions\` | Installed extensions (`@janhq/*`, `llamacpp-extension`, …) | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\media\` | Radium Media output: generated images and video under `outputs\`, thumbnails under `thumbs\`, and `index.json` - the only durable record that a generation happened, including its provenance (provider, model, parameters, resolved seed). Deleting an asset in the library removes the file as well as the index entry. Files a provider wrote elsewhere are *adopted in place* and therefore live outside this folder. | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\logs\app.log` | Application logs (`tauri_plugin_log`) | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\store.json` | Migration / version store | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\Radium\data\mcp_config.json` | MCP servers config | factory reset, `make clean-windows-all`, uninstaller |
| `%APPDATA%\chat.atomic.app\settings.json` | Current `AppConfiguration` (`{ data_folder: ... }`) — new installs | `make clean-windows-all`, uninstaller (Tauri default) |
| `%APPDATA%\Atomic-Chat\settings.json` | Legacy `settings.json` (only present on older installs) | `make clean-windows-all`, uninstaller |
| `%APPDATA%\Atomic Chat\` (before ADR 2026-09-13) | The same data folder under the product name used before the rename. The app moves `data\` to `Radium\data\` on first launch and repoints `settings.json`. It stays here only when the move could not happen, and `app.log` says why. | `make clean-windows-all`, uninstaller |
| `%LOCALAPPDATA%\chat.atomic.app\EBWebView\` | WebView2 storage incl. `localStorage` (`setupCompleted`, `llama_cpp_pending_backend`, `llama_cpp_better_backend_recommendation`, …) | `make dev-windows-cpu` (Local Storage only), `make clean-windows-all`, uninstaller |

### Why several APPDATA folders

`[Cargo.toml].name = "Atomic-Chat"` ≠ `productName = "Radium"` ≠ `identifier = "chat.atomic.app"`. This is historical layout, so the same product writes into several sibling APPDATA directories. `productName` was "Atomic Chat" until ADR 2026-09-13, which renamed it together with a startup migration that moves the old data folder (`src-tauri/src/core/app/data_migration.rs`). The Cargo name and the identifier keep the old names on purpose: the legacy `settings.json` and WebView2 storage live under them, so renaming either would need a migration of its own.

### How to reset for testing

| Need | Command |
|---|---|
| Re-test the bundled CPU backend → GPU auto-download flow | `make dev-windows-cpu` (clears only `backends/` + WebView2 Local Storage + `settings.json`) |
| Full wipe (all data, settings, WebView2 cache) — true first-launch | `make clean-windows-all CONFIRM=1` |
| In-app reset (keeps downloaded backends and the active backend selection) | `Settings → General → Reset to Factory Default` |
| End-user uninstall + delete data | Uninstaller → enable **Delete app data** checkbox |

### Media provider credentials are NOT in the data folder

API keys for cloud media providers live in the **operating system credential
store** - Windows Credential Manager, under the service `Radium Chat - Media` -
not in `settings.json`, not in `localStorage`, and not under `data\`. Nothing in
the table above clears them: factory reset, `make clean-windows-all` and the
uninstaller all leave them untouched. Remove one from `Settings -> Media` (delete
the provider), or from Windows' own Credential Manager. See ADR
`docs/decisions/2026-09-10-store-media-provider-credentials-in-the-os-credential-store.md`.

### Custom data folder

If a user has relocated the data folder via `Settings → Advanced → Change data folder location` (`change_app_data_folder`), the uninstaller and `make clean-windows-all` **do not** delete that custom path — only the default `%APPDATA%\Radium\` (and the pre-rename `%APPDATA%\Atomic Chat\`) is cleaned. Removing a custom data folder is the user's responsibility.
