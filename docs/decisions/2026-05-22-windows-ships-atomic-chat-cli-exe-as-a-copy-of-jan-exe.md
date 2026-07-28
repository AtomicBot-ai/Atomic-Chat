---
date: 2026-05-22
title: "Windows ships `atomic-chat-cli.exe` as a copy of `jan.exe`"
---

# 2026-05-22 — Windows ships `atomic-chat-cli.exe` as a copy of `jan.exe`

- **Context:** Settings UI told users to run `atomic-chat-cli`, but only
  `jan.exe` existed after install (renamed from bundled `jan-cli.exe`). Unix
  was unchanged and still exposes `jan` only.
- **Decision:** On Windows only, after `install_jan_cli` renames to `jan.exe`,
  copy `jan.exe` → `atomic-chat-cli.exe` in the same `resources/bin` directory
  (already on user PATH). Uninstall removes both binaries. Settings copy on
  Windows mentions both names; non-Windows copy says `jan` only.
- **Consequences:** `atomic-chat-cli` works on Windows without renaming legacy
  `jan-cli` / `jan.exe` artefacts. Two copies on disk (~small overhead).
  macOS/Linux unchanged.
- **Owner:** team.
- **Links:** `src-tauri/src/core/system/commands.rs`,
  `web-app/src/routes/settings/general.tsx`.
