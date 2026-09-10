---
date: 2026-08-03
title: "Triage the Sentry backlog: fix real defects and stop reporting recoverable failures as crashes"
---

# 2026-08-03 — Triage the Sentry backlog: fix real defects and stop reporting recoverable failures as crashes

- **Context:** The 30-day unresolved Sentry backlog for `atomic-chat-desktop` and
  `atomic-chat-frontend` was dominated by a handful of groups. Three were real
  mass defects: MCP startup migrations ran before `mcp_config.json` existed and
  failed with `os error 2` on every clean install (`DESKTOP-F/E/G/12/11/13`);
  Windows converted *every* GGUF argument to an 8.3 short path, mangling names
  into `MODEL~1.GGU` (`DESKTOP-9/2HV`); and Tauri listeners registered by async
  effects were detached twice on fast unmount / StrictMode / HMR, throwing
  `listeners[eventId].handlerId` as an unhandled rejection (`FRONTEND-G/5/8`).
  The rest was noise: recoverable model-load errors, failed `--list-devices`
  probes, refusals to download an unresolved `latest` sentinel, offline
  background update checks, and Vite/React-Refresh events from dev machines were
  all logged at `error` level and shipped to Sentry as crashes. Desktop groups
  also showed `Users Impacted: 0` because the Rust client never received the
  anonymous id the webview already had.
- **Decision:** Fix the three defects at their source — bootstrap the MCP config
  via a new `ensure_mcp_config_exists` helper before any migration runs, apply
  the Windows short-path conversion only when a path is non-ASCII (and never for
  split shards), and detach Tauri listeners through a single `createSafeUnlisten`
  wrapper. Separately, treat expected conditions as warnings rather than errors
  across both llama.cpp providers, classify `llama.cpp` exit code 1 from stdout
  when stderr is generic, drop transient network failures and development-only
  events in the two `before_send` hooks, fingerprint the unlisten race into one
  group, and propagate the PostHog anonymous id into the Rust Sentry scope.
  P1 (backend selection / `latest` resolver) was excluded: that surface was
  reworked separately and its Sentry groups predate the rework.
- **Consequences:** Sentry stops being a dumping ground for conditions the app
  already handles, so the remaining volume is actionable. The cost is that a
  genuinely broken update endpoint or device probe now only surfaces as a
  warning in the local log — connectivity-shaped failures are filtered by
  logger + message markers, so a future subsystem that logs through the updater
  loggers could be silenced accidentally. `is_transient_network_failure` and
  `isDevelopmentOnlyEvent` are the two places to widen or narrow that filter.
  Watch the two issue streams after the next release: only groups that stopped
  reproducing should be resolved.
- **Owner:** `team`.
- **Links:**
  `src-tauri/src/core/mcp/helpers.rs`, `src-tauri/src/core/setup.rs`,
  `src-tauri/plugins/tauri-plugin-llamacpp{,-upstream}/src/path.rs`,
  `src-tauri/plugins/tauri-plugin-llamacpp{,-upstream}/src/error.rs`,
  `src-tauri/src/core/updater/custom_updater.rs`,
  `src-tauri/src/core/telemetry/`, `web-app/src/lib/tauriEvent.ts`,
  `web-app/src/lib/sentry.ts`.
