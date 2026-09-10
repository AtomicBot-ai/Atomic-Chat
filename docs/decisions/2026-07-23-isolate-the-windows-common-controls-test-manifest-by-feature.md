---
date: 2026-07-23
title: "Isolate the Windows Common Controls test manifest by feature"
---

# 2026-07-23 — Isolate the Windows Common Controls test manifest by feature

- **Context:** The Common Controls v6 manifest added for Windows libtest was
  emitted through package-wide `cargo:rustc-link-arg`. Tauri already embeds
  the application manifest in `resource.lib`, so linking the desktop binary
  produced `CVT1100: duplicate resource` for manifest resource id 1. Cargo
  rejects `cargo:rustc-link-arg-tests` because this package has no explicit
  `[[test]]` target even though it has a library unit-test harness.
- **Decision:** Gate the package-wide manifest linker arguments behind the
  existing `test-tauri` feature and disable Tauri's generated app manifest
  under that feature. Run the Windows Agent library-test gate with
  `--features test-tauri`; leave normal builds on Tauri's default manifest.
- **Consequences:** The Agent libtest harness retains its Common Controls v6
  activation context without creating a duplicate resource. Normal desktop
  builds receive no custom manifest linker arguments and link only Tauri's
  `resource.lib`.
- **Owner:** team.
- **Links:** [`src-tauri/build.rs`](src-tauri/build.rs),
  [`src-tauri/windows-test.manifest`](src-tauri/windows-test.manifest),
  [`.github/workflows/release.yml`](.github/workflows/release.yml).
