---
date: 2026-09-15
title: "jan-cli keeps its file name and becomes a copy of the core"
---

# 2026-09-15 — jan-cli keeps its file name and becomes a copy of the core

- **Context:** `resources/bin/jan-cli` is referenced by the installer, by Settings → Install CLI,
  by the symlink that lands in `/usr/local/bin`, and by every doc and support answer. The
  TypeScript core replaces what that binary does, but renaming it would break all of that at once,
  for no user-visible benefit.
- **Decision:** The file name stays `jan-cli[.exe]`. `make build-cli` copies the downloaded
  `atomic-chat-core` over it and signs it; `CLI_IMPL=rust` restores the previous `cargo build
  --features cli` path and remains the rollback. The core's own name is used only for the bundled
  resource and the release assets. The CLI's flags, defaults and exit codes match the Rust binary
  (`serve` on 6767, `models list --json` fields, `server status` exiting 1 when unreachable) so a
  script cannot tell which implementation it is talking to, except where the owner model makes a
  difference we document.
- **Consequences:** Users keep the command they know and an upgrade is a binary swap. Two CLI
  implementations exist during the migration, so `cli-launch-catalog.test.mjs` compares the shipped
  binary's agent catalog against `integrations.ts`, and the Rust `cli` feature keeps building in CI
  as proof the rollback still works. The `install_jan_cli_sync` command and the Launch page are
  untouched.
- **Owner:** team
- **Links:** `Makefile` (`CLI_IMPL`, `build-cli-core`, `build-cli-rust`),
  `tests/cli-launch-catalog.test.mjs`
