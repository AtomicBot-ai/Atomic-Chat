---
date: 2026-06-29
title: "Auto-install Node.js/npm via `winget` when an npm-based Launch-page agent is installed on a Windows host without npm (graceful fallback to the nodejs.org error)"
---

# 2026-06-29 — Auto-install Node.js/npm via `winget` when an npm-based Launch-page agent is installed on a Windows host without npm (graceful fallback to the nodejs.org error)

- **Context:** `install_agent`
 ([`commands.rs`](src-tauri/src/core/system/commands.rs)) gates every
 Launch-page agent install on its prerequisite binary
 (`agent_install_spec` → `prereq`: `npm` for Claude Code / Codex / OpenCode /
 OpenClaw / Cline / MiMo / Pi / Kilo, `curl` for Goose/Hermes, etc.). When
 the prereq was missing it returned an actionable-but-manual error
 ("Install Node.js from https://nodejs.org, then restart Atomic Chat"). So a
 fresh Windows machine with no Node couldn't one-click-install any npm-based
 agent — the user had to leave the app, install Node, restart, and retry.
- **Decision (per the user-chosen options — `winget`, **Windows-only**,
 **graceful** fallback; no IPC/schema/contract change):** Before giving up on
 a missing **npm** prereq, attempt to auto-install Node.js LTS (which bundles
 npm) via the Windows Package Manager. New `#[cfg(windows)]`
 `try_bootstrap_npm_via_winget(app_handle, event, proxy)` (a `#[cfg(not(windows))]`
 twin returns `false`): (1) probes `winget` itself via the existing
 `detect_agent_installed` (App Installer ships on Win10 1809+ mainline but not
 LTSC/Server/stripped images); (2) spawns
 `winget install --id OpenJS.NodeJS.LTS -e --silent --accept-package-agreements
 --accept-source-agreements` with `CREATE_NO_WINDOW`, `apply_runtime_path` (the
 registry+npm-prefix PATH refresh from the same-day ADR below) and
 `apply_proxy_env`, streaming stdout/stderr to the **same**
 `agent_install_log:<id>` event the agent installer uses so the UI shows
 progress; (3) re-checks `npm` via `detect_agent_installed` (which re-reads the
 registry PATH at runtime, so the freshly-installed npm resolves without an app
 restart). The `install_agent` prereq block now defines `event` up front, and
 when the prereq is missing it tries the bootstrap **only when `prereq == "npm"`**
 and only on a successful re-detect continues; otherwise it returns the
 unchanged actionable nodejs.org error. `ProxyEnv` already derives `Clone`, so
 the proxy is passed to both the bootstrap and the later install closure.
- **Consequences:** On Windows, installing an npm-based agent on a Node-less
 machine now silently bootstraps Node.js LTS via winget (one UAC prompt from
 winget itself) and proceeds — the Launch flow works end-to-end from the
 packaged app. When winget is absent, the install fails, or npm still isn't
 found, it degrades to the existing manual-install error (no behaviour change
 for that path). **Deliberately NOT done (out of scope):** the MSI-from-nodejs.org
 and bundled-portable-Node-sidecar alternatives (heavier: own download/verify +
 UAC, or +~50-90 MB installer + a new build-pipeline branch); auto-installing
 the `curl`/`powershell` prereqs (non-npm agents are unaffected); any
 macOS/Linux auto-install (their npm-missing path keeps the manual error per the
 chosen Windows-only scope). **Verified:** `cargo check -p Atomic-Chat` clean
 (exit 0; only pre-existing unrelated `dead_code` / `unused_mut` /
 `non_snake_case` warnings in the mlx / llamacpp / hardware / vector-db plugins).
 A live Windows smoke test (Node-less host → install an npm agent → winget
 bootstraps Node → agent installs) is the residual manual step (no such host in
 the sandbox).
- **Owner:** team.
- **Links:** the same-day ADR *Refresh PATH (+ npm global prefix) for the
 Launch-page interactive agent terminal …* (the `apply_runtime_path` /
 `refresh_windows_path` machinery this reuses), the 2026-06-25 ADR *Propagate
 the app proxy into Launch-page agent installers …*, the 2026-06-01 ADR *Add a
 "Launch" page …*, files:
 [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 (`try_bootstrap_npm_via_winget`, `install_agent` prereq block).

---
