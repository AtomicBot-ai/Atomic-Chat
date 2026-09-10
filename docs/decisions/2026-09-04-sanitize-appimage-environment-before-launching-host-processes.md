---
date: 2026-09-04
title: "Sanitize the AppImage environment before launching host processes"
---

# 2026-09-04 — Sanitize the AppImage environment before launching host processes

- **Context:** AppRun prepends Atomic Chat's bundled libraries and plugin paths
  to the app environment. A child host executable inherits those paths by
  default, so Fedora's `/lib64/libcurl.so.4` loaded the AppImage's Ubuntu 22.04
  `libssl.so.3` and failed on missing `OPENSSL_3.2.0` / `OPENSSL_3.5.0` symbols
  when the Launch page ran Atomic Agent's `curl | sh` installer. The updater
  restart already removed the same AppImage variables after issue #164, but
  other host-process boundaries did not.
- **Decision:** Keep the AppImage environment for Atomic Chat and inference
  sidecars deliberately launched inside its runtime, but remove its runtime
  variables whenever an AppImage run intentionally launches a host executable.
  Apply the shared cleanup to Launch-page installers and terminals, MCP stdio
  servers, and Agent shell / PTY processes. Source/development runs keep their
  environment unchanged. Run Unix `curl | shell` installers with Bash
  `pipefail` so a download failure is never masked by the downstream shell.
- **Consequences:** Host tools resolve their own distro libraries instead of
  mixing them with the AppImage. Adding another host-process boundary requires
  opting into the shared sanitizer; inference sidecars that rely on the
  AppImage runtime must not use it. Unix installer specs now require Bash,
  already required by existing installers.
- **Owner:** team.
- **Links:** [Issue #164](https://github.com/AtomicBot-ai/Atomic-Chat/issues/164),
  [superseded draft PR #229](https://github.com/AtomicBot-ai/Atomic-Chat/pull/229),
  `src-tauri/src/core/process_env.rs`,
  `src-tauri/src/core/system/commands.rs`,
  `src-tauri/src/core/mcp/helpers.rs`,
  `src-tauri/src/core/agent/tools/shell.rs`,
  `src-tauri/src/core/agent/pty.rs`
