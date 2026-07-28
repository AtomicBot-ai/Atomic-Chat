---
date: 2026-06-29
title: "Refresh PATH (+ npm global prefix) for the Launch-page interactive agent terminal so npm-installed agent shims resolve on Windows from the packaged app"
---

# 2026-06-29 — Refresh PATH (+ npm global prefix) for the Launch-page interactive agent terminal so npm-installed agent shims resolve on Windows from the packaged app

- **Context:** On Windows, pressing **Run** on a Launch-page coding agent
 (Claude Code, Codex, OpenCode, …) opened a `cmd` console that reported
 `'claude' is not recognized as an internal or external command`, even though
 the agent's npm-global shim (`claude.cmd`) was installed in `%APPDATA%\npm`.
 Developers running `yarn dev` from a terminal never saw it (their shell PATH
 is already complete), but a packaged `.exe` launched from Explorer snapshots
 PATH once at startup via `fix_path_env::fix()` — so Node/npm installed (or
 `%APPDATA%\npm` broadcast to the user PATH) after first launch stayed
 invisible to spawned subprocesses. Root cause was an **asymmetry** in
 [`open_agent_terminal`](src-tauri/src/core/system/commands.rs): the
 `detect_agent_installed` (`detect_on_native_path`) and `install_agent` paths
 already call `apply_login_path` + `apply_runtime_path` (the 2026-06-25 ADR's
 `refresh_windows_path` registry refresh), but the Windows branch of
 `open_agent_terminal` spawned `cmd /C start "" cmd /K <agent>` with **no**
 PATH refresh — the launched console inherited only the stale startup
 snapshot. Compounding it, even a refreshed registry PATH can legitimately
 lack `%APPDATA%\npm` if the user PATH entry hadn't been broadcast yet, and
 that dir is exactly where `install_agent`'s own `npm i -g` lands.
- **Decision (two minimal, complementary fixes; no IPC/schema/contract change):**
 1. **Single source of truth — `refresh_windows_path()` now always includes
 the npm global prefix.** It computes `%APPDATA%\npm` (the default npm global
 bin dir on Windows, where global shims live) and folds it into the merged,
 de-duplicated machine→user→npm→live PATH. The early `None` guard is relaxed
 to also consider the npm dir, so the function can still contribute it even
 if both registry-scope reads fail. Because all three spawn sites (detect /
 install / terminal) flow through `apply_runtime_path` →
 `refresh_windows_path`, every one of them now resolves npm-installed agents
 regardless of whether the registry PATH carries `%APPDATA%\npm`. Cheap (an
 env-var join, no `npm prefix -g` process spawn — keeps the per-agent detect
 probe fast); a non-existent dir is a harmless PATH entry.
 2. **`open_agent_terminal` applies the refreshed PATH.** The Windows branch
 calls `apply_runtime_path(&mut cmd)` on the outer `cmd` before spawn (the
 launched console inherits this env, exactly like the existing proxy-env
 propagation). For symmetry, the Linux branch now also calls
 `apply_login_path` + `apply_runtime_path` (the macOS branch returns early
 and is unaffected; `bash -lc` there already resolves PATH, so it's belt-and-
 suspenders, mirroring detect/install).
- **Consequences:** A freshly-installed (or registry-only) npm agent shim now
 resolves in the Run terminal without an app restart, so the Launch flow works
 for Windows users from the packaged app. **Deliberately NOT done (out of
 scope):** querying the actual `npm prefix -g` for a *custom* npm prefix (rare;
 the `%APPDATA%\npm` default — also where our own `install_agent` writes —
 covers the overwhelming majority, and spawning npm on every detect probe
 would add latency); no change to the proxy-propagation or iGPU-gate logic of
 the 2026-06-25 ADR. **Verified:** `cargo check -p Atomic-Chat` clean (exit 0;
 only pre-existing unrelated `dead_code` / `unused_mut` / `non_snake_case`
 warnings in the mlx / llamacpp / hardware / vector-db plugins). A live
 Windows packaged-build smoke test (install Node after first launch → Run →
 agent resolves) is the residual manual step (no such host in the sandbox).
- **Owner:** team.
- **Links:** the 2026-06-25 ADR *Propagate the app proxy into Launch-page agent
 installers, refresh the Windows PATH at install/detect time …* (the
 `refresh_windows_path` / `apply_runtime_path` machinery this extends), the
 2026-06-04 ADR *Resolve the login-shell PATH for Launch-page agent
 detection/install*, the 2026-06-01 ADR *Add a "Launch" page …*, files:
 [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 (`refresh_windows_path` npm-prefix inclusion, `open_agent_terminal` Windows +
 Linux PATH application).

---
