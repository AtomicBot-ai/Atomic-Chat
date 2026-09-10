---
date: 2026-06-15
title: "Detect Launch-page agents installed inside WSL + add a manual binary-path override (detection-only) (ATO-169)"
---

# 2026-06-15 — Detect Launch-page agents installed inside WSL + add a manual binary-path override (detection-only) (ATO-169)

- **Context:** Community request (Discord, m.iko). On Windows many CLI agents are
  installed inside **WSL** (they want a bash environment), not in native
  cmd/PowerShell. Detection
  ([`detect_agent_installed`](src-tauri/src/core/system/commands.rs)) was a pure
  native-PATH lookup — `where` (Windows) / `which` (Unix) — with
  `apply_login_path` a no-op on Windows. So a WSL-installed tool was invisible
  (`where.exe` only sees the Win32 PATH) and showed as "Not installed" with no
  way for the user to correct it. There was also no manual path override for
  agents installed in any non-standard location. The frontend
  ([`launch/index.tsx`](web-app/src/routes/launch/index.tsx)) ran detection per
  catalog entry ([`integrations.ts`](web-app/src/constants/integrations.ts)).
- **Decision (per the chosen scope — *detection-only*):** Both new signals
  affect **only** the Installed/Not status; Enable/Run stays native and
  unchanged. A full end-to-end WSL path (configure into the WSL home + launch via
  `wsl.exe`) was **deliberately deferred** — a Windows process cannot exec the
  Linux ELF binary directly even given its `\\wsl$\…` path, so making Enable work
  through WSL is a large, separate cross-filesystem effort. Manual path is
  likewise scoped to detection (it mainly helps native installs in odd
  locations; it does not make WSL launch work).
  1. **Rust** ([`commands.rs`](src-tauri/src/core/system/commands.rs)):
     `detect_agent_installed` now takes `custom_path: Option<String>` and returns
     a struct `AgentDetection { installed, via_wsl }` (was `bool`). Resolution
     order: (1) `custom_path` is authoritative when non-empty — installed iff the
     file exists; (2) native PATH lookup (`detect_on_native_path`); (3) Windows
     only — `detect_via_wsl` runs `wsl.exe -e sh -lc 'command -v <bin>'` (login
     shell so the user's WSL `PATH` is in scope), setting `via_wsl = true`. Both
     spawned probes keep `CREATE_NO_WINDOW`. The agent names come from a fixed
     catalog, so the `sh -lc` interpolation has no injection surface. The
     internal `install_agent` prereq caller was updated to `…(prereq, None).await.installed`.
  2. **Frontend:** new persisted store
     [`launch-settings-store.ts`](web-app/src/stores/launch-settings-store.ts)
     (`customPaths`, key `launch-custom-paths` in
     [`localStorage.ts`](web-app/src/constants/localStorage.ts)) — survives
     reloads, unlike the intentionally-transient
     [`launch-store.ts`](web-app/src/stores/launch-store.ts) (which gained a
     transient `viaWsl` map). `detect` passes `customPath` and records
     `installed` + `viaWsl`; the mount effect re-detects when `customPaths`
     changes, so saving a path refreshes status automatically. UI: an
     "Installed (WSL)" badge variant, and a collapsible per-agent "Set binary
     path" editor (shared `Input` + Save, local draft state). New EN i18n keys in
     [`launch.json`](web-app/src/locales/en/launch.json) (only EN exists for this
     namespace; others fall back).
- **Consequences:** WSL-installed agents on Windows now show "Installed (WSL)"
  instead of "Not installed", and any agent can be force-marked installed via an
  explicit path — directly fixing the "can't even see it's installed / can't fix
  it" complaint. **Deliberately not done (deferred):** running configure/launch
  through WSL, and threading the custom path into `configure_*` / the launch
  terminal (so enabling a WSL-only agent still isn't wired end-to-end — the badge
  is informational). Scope: 1 Rust command (+2 helpers, 1 struct) and 4 web-app
  files; no IPC beyond the command's new param/return shape, no on-disk layout
  change. **Verified:** `cargo check -p Atomic-Chat` 0 errors (pre-existing
  dead_code warnings only; the `#[cfg(windows)]` WSL helper isn't compiled on the
  macOS dev host); `tsc -b` clean; `eslint` clean on all touched web-app files.
- **Owner:** team.
- **Links:** [ATO-169](https://linear.app/atomicchat/issue/ATO-169), the
  2026-06-04 ADR *Resolve the login-shell PATH for Launch-page agent detection*,
  the 2026-06-01 ADR *Add a "Launch" page …*, files:
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
  (`detect_agent_installed`, `detect_on_native_path`, `detect_via_wsl`,
  `AgentDetection`),
  [`web-app/src/stores/launch-settings-store.ts`](web-app/src/stores/launch-settings-store.ts),
  [`web-app/src/stores/launch-store.ts`](web-app/src/stores/launch-store.ts),
  [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx),
  [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts),
  [`web-app/src/locales/en/launch.json`](web-app/src/locales/en/launch.json).
