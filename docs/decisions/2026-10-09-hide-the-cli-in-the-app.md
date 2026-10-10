---
date: 2026-10-09
title: "Hide the CLI in the app, and stop installing it on launch"
---

# 2026-10-09 — Hide the CLI in the app, and stop installing it on launch

- **Context:** Settings → General → Advanced offered "Atomic Chat CLI" Install / Uninstall, and every
  launch copied the bundled `jan-cli` onto the user's PATH as `atomic-chat-cli` when it was missing
  (and overwrote it after each update). The command-line product is moving to Atomic Server (`atc`,
  repo `atomic-chat-cli`), a separate product with its own release; the app-bundled CLI keeps its
  own data scope (`2026-09-17-isolate-app-and-cli-cores.md`), so models installed in the app are not
  visible to it anyway. Offering it in the app, and putting it on PATH unasked, promises something
  we no longer develop there.
- **Decision:** The Settings row, its state and its strings (`atomicBotCli*` in en/ja/ko) are
  removed. `setup_jan_cli` no longer installs: on a version change it refreshes an
  `atomic-chat-cli` that is already on PATH, so existing users keep a binary in sync with the app;
  otherwise it does nothing. The bundled `jan-cli`, `install_jan_cli_sync` and the
  `check/install/uninstall_jan_cli` commands stay, so bringing the row back is a UI change only.
- **Consequences:** New installs no longer get `atomic-chat-cli` on PATH. Users who already have it
  keep it and get updates, but can no longer remove it from the app; deleting the file (or
  `~/.local/bin/atomic-chat-cli`, `/usr/local/bin/atomic-chat-cli`, the Windows user PATH entry)
  removes it. On Windows an update that drops the copied `atomic-chat-cli.exe` from
  `resources\bin` stops the refresh, because the command is then no longer found on PATH.
- **Owner:** `team`.
- **Links:** `web-app/src/routes/settings/general.tsx`, `src-tauri/src/core/setup.rs`
  (`setup_jan_cli`), `src-tauri/src/core/system/commands.rs`.

<!--
Supersedes: none (narrows the Settings → Install CLI surface named in 2026-09-15-jan-cli-keeps-its-name-and-becomes-the-core.md)
-->
