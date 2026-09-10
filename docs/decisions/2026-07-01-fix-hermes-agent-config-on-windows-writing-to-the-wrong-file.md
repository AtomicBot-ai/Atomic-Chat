---
date: 2026-07-01
title: "Fix Hermes Agent config on Windows writing to the wrong file (`%USERPROFILE%\.hermes` vs the installer's real `HERMES_HOME`), plus a stale-registry-env guard"
---

# 2026-07-01 — Fix Hermes Agent config on Windows writing to the wrong file (`%USERPROFILE%\.hermes` vs the installer's real `HERMES_HOME`), plus a stale-registry-env guard

- **Context:** A Windows user reported that changing the model in Settings →
  Hermes Agent had no effect — the `hermes` CLI kept using its old model.
  Root-caused via two focused subagent investigations (codebase patterns +
  Hermes installer mechanics), confirmed against the upstream
  `NousResearch/hermes-agent` `install.ps1` and Python source:
  1. **Wrong file, unconditionally.** `configure_hermes_agent` /
     `clear_hermes_agent_config`
     ([`commands.rs`](src-tauri/src/core/system/commands.rs)) always wrote to
     `%USERPROFILE%\.hermes\config.yaml`. But the official Windows installer
     (`install.ps1`) sets `HERMES_HOME` to `%LOCALAPPDATA%\hermes` via
     `[Environment]::SetEnvironmentVariable("HERMES_HOME", ..., "User")` and
     seeds a template `config.yaml` there — even with `-SkipSetup
     -NonInteractive` (those flags only skip the interactive API-key/model
     wizard, not the `HERMES_HOME` env-var setup or directory scaffolding).
     Hermes' own `hermes_constants.py::get_hermes_home()` resolves
     `os.environ["HERMES_HOME"]` first, then falls back to
     `%LOCALAPPDATA%\hermes` — **never** `%USERPROFILE%\.hermes`, which isn't
     a Hermes default on any platform. So our app was patching a file the
     `hermes` CLI never reads.
  2. **Stale env var, same-session.** Even a naive `std::env::var("HERMES_HOME")`
     read would be unreliable: the Launch page's Run flow calls
     `install_agent` (spawns `install.ps1`, which writes `HERMES_HOME` to
     `HKCU\Environment`) and `configure_hermes_agent` back-to-back in the
     *same* already-running Tauri process, whose environment block is a
     snapshot taken at its own startup — registry writes from a child
     installer never propagate back into it. (Hermes' own official Electron
     desktop app hit and fixed this exact gap by reading the registry
     directly — precedent confirmed in
     `apps/desktop/electron/windows-user-env.cjs`.)
- **Decision:** New `resolve_hermes_dir()` helper
  ([`commands.rs`](src-tauri/src/core/system/commands.rs)), used by both
  `configure_hermes_agent` and `clear_hermes_agent_config`, replacing the
  hardcoded `USERPROFILE\.hermes` / `HOME/.hermes` split. On Windows it tries,
  in order: (1) a **fresh** registry read of `HERMES_HOME` via new
  `#[cfg(windows)] read_windows_user_env(name)` (spawns
  `powershell -NoProfile -Command "[Environment]::GetEnvironmentVariable('HERMES_HOME', 'User')"`,
  `CREATE_NO_WINDOW`, mirroring the existing `refresh_windows_path::read_scope`
  PATH-refresh pattern rather than adding a new `winreg`-based path — the
  crate is already a dependency but this keeps the read symmetric with the
  proven PATH mechanism); (2) the process's own (possibly stale but
  non-worse) `HERMES_HOME` env var, in case a previous launch already picked
  it up; (3) `%LOCALAPPDATA%\hermes` — Hermes' genuine platform default. Off
  Windows, behavior is unchanged (`$HOME/.hermes`).
- **Consequences:** Model/base-URL/provider changes made in Settings → Hermes
  Agent (and the Launch-page one-click Run flow) now land in the file the
  `hermes` CLI actually reads, on both a fresh install (installer just ran,
  same session) and a pre-existing install. No IPC, schema, or on-disk-layout
  change beyond which directory is targeted; macOS/Linux (`$HOME/.hermes`)
  are untouched. **Deliberately not done:** no generic reusable
  "read any Windows user env var" abstraction beyond this one function (the
  existing `refresh_windows_path` remains PATH-specific and unchanged); no
  `winreg`-crate-based read was introduced (the PowerShell approach mirrors
  the already-proven pattern one function above it). **Verified:**
  `cargo check -p Atomic-Chat` clean (0 errors, only the pre-existing
  unrelated `FileMetadata` dead_code warning in `tauri-plugin-vector-db`);
  `ReadLints` clean on the edited file. A live Windows smoke test (install
  Hermes fresh -> change model in Settings -> confirm `hermes` picks it up)
  is the residual manual step (no such host in the sandbox).
- **Owner:** team.
- **Links:** the 2026-06-01 ADR *Add a "Launch" page ...* (the
  `configure_hermes_agent` / `install_agent` sequencing this fix corrects
  for), the 2026-06-29/2026-06-25 ADRs on Windows PATH refresh (the
  `read_scope` / `refresh_windows_path` pattern reused here), files:
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
  (`resolve_hermes_dir`, `read_windows_user_env`, `configure_hermes_agent`,
  `clear_hermes_agent_config`),
  [`web-app/src/routes/settings/hermes-agent.tsx`](web-app/src/routes/settings/hermes-agent.tsx).
