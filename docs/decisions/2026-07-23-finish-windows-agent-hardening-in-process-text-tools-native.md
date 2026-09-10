---
date: 2026-07-23
title: "Finish Windows Agent hardening: in-process text tools, native trash, test harness"
---

# 2026-07-23 — Finish Windows Agent hardening: in-process text tools, native trash, test harness

- **Context:** The Windows Agent hardening plan still needed verified
  malformed-verbatim path coverage, replacement of external `grep`/`diff`/
  `patch`/`trash` shell helpers, native Recycle Bin deletion, and a way to
  run `cargo test --lib` on Windows after Tauri-linked harnesses died at
  process start with `STATUS_ENTRYPOINT_NOT_FOUND` (0xc0000139) because
  libtest imported Common Controls v6 APIs without a v6 activation context.
- **Decision:** Keep grep/diff/patch fully in-process (`ignore` + `regex` +
  `diffy`) with a 1 MiB text-file cap and symlink-skipping walks; route trash
  through the `trash` crate; emit workspace-relative `/`-separated path labels
  (stripping `\\?\` before prefixing) so authorization-rewritten absolute args
  do not leak verbatim paths into observations; embed
  `windows-test.manifest` via `build.rs` `cargo:rustc-link-arg` so Windows
  libtest harnesses activate Common Controls v6.
- **Consequences:** Agent file tools no longer depend on host GNU/BusyBox
  utilities; Windows deletions use the Recycle Bin API; path/diff/glob/grep
  contract tests and the release Agent gate can run on Windows. The manifest
  link-arg also applies when linking non-test artefacts from this crate — it
  only adds the same Common Controls v6 dependency Tauri already ships.
- **Owner:** team.
- **Links:** [`src-tauri/src/core/agent/tools/fs.rs`](src-tauri/src/core/agent/tools/fs.rs),
  [`src-tauri/src/core/agent/tools/contract_tests.rs`](src-tauri/src/core/agent/tools/contract_tests.rs),
  [`src-tauri/build.rs`](src-tauri/build.rs),
  [`src-tauri/windows-test.manifest`](src-tauri/windows-test.manifest),
  [`.github/workflows/release.yml`](.github/workflows/release.yml).
