---
date: 2026-10-21
title: "Register the atomic-chat:// link scheme on Windows and Linux"
---

# 2026-10-21 — Register the atomic-chat:// link scheme on Windows and Linux

- **Context:** `atomic-chat://` links opened the app only on macOS, where `src-tauri/Info.plist` declares the scheme. `tauri.conf.json` had no `plugins.deep-link` entry, and `tauri-plugin-deep-link` does nothing without one: `register_all()` returns early, a cold-start URL in `argv` is dropped, and the bundler writes the NSIS/MSI registry keys and the Linux handler entry only from `plugins.deep-link.desktop`. Hugging Face's "Use this model" menu offers this link on every platform.
- **Decision:** Declare `plugins.deep-link.desktop.schemes = ["atomic-chat"]` in `tauri.windows.conf.json` and `tauri.linux.conf.json` only. The base config stays as it was, so the macOS bundle keeps its `Info.plist` entry and gains no second one. At startup `register_all()` runs on Windows and Linux outside e2e builds; its failure is logged, not fatal, since on Linux it needs `xdg-mime` and `update-desktop-database`. The single-instance callback brings the main window forward on those platforms, where a link opened while the app runs arrives in the running instance.
- **Consequences:** Installers register the scheme; a build that was not installed (an AppImage, a dev build) registers itself on first start, as the plugin intends. An e2e binary does not, because the handler is one registry key or desktop entry per user and a test binary refuses to start without `ATOMIC_E2E_DATA_ROOT`; `tests/e2e-config.test.mjs` pins this. Only the macOS build was compiled here; the Windows and Linux paths need a build on their platform.
- **Owner:** team.
- **Links:** `src-tauri/tauri.windows.conf.json`, `src-tauri/tauri.linux.conf.json`, `src-tauri/src/lib.rs`, `src-tauri/Info.plist`, `tests/e2e-config.test.mjs`; [2026-10-12 — Open a linked safetensors repository as a managed checkpoint](2026-10-12-open-a-linked-safetensors-repository-as-a-managed-checkpoint.md); [tauri-plugin-deep-link](https://v2.tauri.app/plugin/deep-linking/).
