---
date: 2026-06-04
title: "Resolve the login-shell PATH for Launch-page agent detection/install (fix `command not found` in packaged macOS builds)"
---

# 2026-06-04 — Resolve the login-shell PATH for Launch-page agent detection/install (fix `command not found` in packaged macOS builds)

- **Context:** A user on a packaged macOS build reported the Launch-page
  one-click flow failing: the bundled installers (and the auto-opened terminal)
  could not find `npm`/`node` or the freshly-installed agent binaries (e.g.
  `openclaw`), even though they were installed via Homebrew/nvm. Root cause: a
  GUI app launched from Finder/Dock inherits the minimal **launchd** PATH
  (`/usr/bin:/bin:/usr/sbin:/sbin`), which excludes the user tool dirs
  (`/opt/homebrew/bin`, `~/.nvm/versions/node/*/bin`, `~/.local/bin`, Volta,
  etc.). So both `detect_agent_installed` (`which`/`where`) and `install_agent`
  (spawning `npm`/`curl`/`powershell`) searched the wrong PATH. This affects
  **every** npm-based agent (Claude Code, Codex, OpenCode, Copilot, Droid,
  OpenClaw) only in packaged builds — `make dev` inherits the terminal PATH and
  masked the bug.
- **Decision:** Resolve the user's real PATH from their interactive login shell
  and apply it to the commands we spawn. New helpers in
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs):
  1. `login_shell_path()` (Unix-only) runs `$SHELL -lic 'printf …"$PATH"'`
     (`-l` sources `.zprofile`/`.bash_profile` where Homebrew shellenv lives;
     `-i` sources `.zshrc`/`.bashrc` where nvm lives), parses the value out of a
     `__OCPATH__…__OCEND__` sentinel (so rc files that echo to stdout can't
     corrupt it), and caches the result in a `OnceLock` for the process lifetime
     (one shell spawn, not one per agent probe). Returns `None` on failure.
  2. `apply_login_path(&mut Command)` sets `PATH` from that value when present;
     **no-op on Windows**, where processes inherit the registry (user/system)
     PATH and the minimal-PATH problem does not occur (a restart after a fresh
     Node install is the only Windows caveat — out of scope here).
  Both `detect_agent_installed` and the `install_agent` spawn closure now call
  `apply_login_path` before launching. The auto-opened terminal
  (`open_agent_terminal`) already runs the user's login shell, so it needed no
  change.
- **Consequences:**
  - Packaged macOS/Linux builds find `npm`/`node` and the installed agent
    binaries reliably, with no user-visible permission prompt — the only
    prerequisite remains that Node/npm is installed on the machine.
  - One extra (cached) login-shell spawn per app session, ~1s, paid once.
  - Falls back safely to the inherited PATH if the probe fails or returns empty.
  - Windows behaviour is unchanged (still `cmd /C npm …`, inherited PATH).
- **Owner:** team.
- **Links:** Launch-page agents integration (this session),
  [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
  (`login_shell_path`, `apply_login_path`, `detect_agent_installed`,
  `install_agent`).
