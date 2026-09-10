---
date: 2026-09-01
title: "Track OpenClaw 2026.8: detect the app-installed CLI, widen an existing `modelPolicy.allow`, and gate the npm/Node prerequisites"
---

# 2026-09-01 — Track OpenClaw 2026.8: detect the app-installed CLI, widen an existing `modelPolicy.allow`, and gate the npm/Node prerequisites

- **Context:** OpenClaw published `2026.8.1` on 2026-08-31 (npm `latest`, plus
 `OpenClaw-2026.8.1.dmg` and the `OpenClawCompanion-Setup-{x64,arm64}.exe`
 Windows Hub in the same GitHub release). Our Launch-page integration was
 written against `2026.5`/`2026.6` and had drifted in four ways, all verified
 against the upstream docs and — where the installed CLI allows it — against
 `openclaw config validate`:
 1. **The desktop apps are invisible to detection.** OpenClaw's prefix
 installer (`install-cli.sh`) writes its launcher to `<prefix>/bin/openclaw`
 (default prefix `~/.openclaw`) and never touches `PATH`, and the macOS app
 runs exactly that installer during its own onboarding. So every user who
 installed the app rather than the npm package had a working OpenClaw that
 `which openclaw` could not see: the card read "Not installed" and Run
 offered to npm-install a *second* copy on top of the app's.
 2. **`agents.defaults.models` is no longer the allowlist.** Since the
 legacy-policy migration it stores aliases and per-model settings only —
 "adding an entry does not restrict model overrides". The real gate is
 `agents.defaults.modelPolicy.allow`, and when it is non-empty it governs
 `/model`, session overrides and `--model`. A user who had restricted their
 agent to a cloud provider would see Run report success and then be told our
 model is not allowed.
 3. **The npm and Node prerequisites moved.** Upstream now documents
 `npm install -g openclaw@latest --allow-scripts=openclaw` for npm 12 /
 11.16+ (and explicitly *omit the flag* on 11.15 and earlier), and the
 published `engines` is `>=22.22.3 <23 || >=24.15.0 <25 || >=25.9.0` — Node
 23 is unsupported outright. We passed a bare `npm install -g openclaw` and
 checked only that `npm` existed; npm merely *warns* on an engines mismatch,
 so an unsupported Node produced a "successful" install that failed at every
 later invocation.
 4. **`AgentDetection.via_wsl` never reached the UI.** The struct had no
 `rename_all`, so serde emitted `via_wsl` while the Launch page read
 `viaWsl` — the "Installed (WSL)" badge could not render for any agent.
- **Decision:** Extend the existing OpenClaw card rather than adding a second
 one for the app. The app and the CLI share `~/.openclaw/openclaw.json`, the
 Gateway owns that file and hot-reloads it, and the Gateway itself is external
 to the app (a launchd `ai.openclaw.gateway` service on macOS) — so
 `configure_openclaw` is already the whole integration for app users. Only two
 things differ, and both are branches inside the one card:
 - **Detection** falls back to `off_path_candidates` — `$OPENCLAW_PREFIX/bin`,
 `~/.openclaw/bin`, `~/.local/bin`, with `.cmd`/`.exe` names on Windows —
 after `which`/`where` misses. `AgentDetection` gained a `path` field, set
 only for off-`PATH` hits, and the terminal command is built from it
 (shell-quoted) instead of the bare binary name. `atomic-chat-cli launch`
 resolves the same way through a re-export.
 - **Run** calls the new `launch_openclaw_app` first. On macOS that opens
 `OpenClaw.app` (`/Applications` or `~/Applications`) the way `launch_zed`
 opens Zed. Windows Hub installs per-user with no documented install path or
 AUMID, so there we only *detect* it — via `%LOCALAPPDATA%\OpenClawTray`,
 the one location the docs pin down — and tell the user to open it from the
 tray. Only when no app is present do we fall back to `openclaw chat`.
 `configure_openclaw` keeps seeding `agents.defaults.models` (pre-migration
 builds still read it as the allowlist) and now also appends `atomic/*` to
 `agents.defaults.modelPolicy.allow` — but **only when that list already
 exists and is non-empty**. Absent or `[]` already means "allow any model", so
 writing one there would introduce a restriction nobody asked for.
 `install_agent` gates the OpenClaw install on `node_meets_openclaw_engines`
 and appends `--allow-scripts=openclaw` only on npm ≥ 11.16.
- **Consequences:** App-only installs are detected, configured and launched
 without a duplicate npm copy. Users with a restrictive model policy get a
 working model instead of a rejection at first message. An unsupported Node
 fails at install time with the exact supported ranges instead of silently
 later. The WSL badge works again for every agent.
 Deliberately **not** changed, and still true:
 - The config write is still a full parse-and-rewrite, so JSON5 comments are
 still dropped (the 2026-06-05 trade-off stands). Upstream now offers
 `openclaw config set … --strict-json --merge`, which would preserve them at
 the cost of a hard dependency on the CLI being present and parseable at
 configure time; not taken here.
 - Per-agent `agents.entries.*.modelPolicy.allow` replaces the default policy
 for that agent and is left alone — those are explicit per-agent decisions,
 not the default Run target.
 - `agents.defaults.model.primary` does not rewrite **existing session pins**;
 upstream requires `/model default` in the pinned chat. There is no CLI or
 config route to clear a pin, so the Run toast now says so instead.
 - On Windows, Hub's "Set up locally" provisions an app-owned
 `OpenClawGateway` **WSL distro** and installs the Gateway inside it, whose
 config is `\\wsl$\OpenClawGateway\…/.openclaw/openclaw.json` — not the
 Windows-side file we write, and reaching our loopback server from that VM
 is a separate networking question. That configuration is out of scope; the
 native Windows CLI/Gateway path is what this covers. (The same
 Windows-config-vs-WSL-agent gap exists for every agent `detect_via_wsl`
 reports and predates this change.)
 - `models.providers.<id>.localService`, which would let OpenClaw start our
 server on demand instead of failing when Atomic Chat is closed, is a
 follow-up feature, not part of this fix.
 Verified: `openclaw config validate` (2026.6.1) accepts our generated config;
 the `modelPolicy` key itself is rejected by 2026.6.1's schema, but only ever
 written when the user's config already contains it, which that schema makes
 impossible. `cargo test --lib` (802 passed, 10 new), `vitest --run`
 (2458 passed), `tsc --noEmit`, ESLint and Prettier all clean.
- **Owner:** team.
- **Links:** upstream docs `docs.openclaw.ai` — `/platforms/mac/bundled-gateway`,
 `/platforms/windows`, `/install/installer`, `/concepts/models`,
 `/gateway/configuration`, `/gateway/local-models`, `/cli/tui`;
 [`openclaw/openclaw` v2026.8.1](https://github.com/openclaw/openclaw/releases/tag/v2026.8.1);
 the 2026-06-03 ADR *Fix OpenClaw Launch integration*, the 2026-06-05 ADR
 *Parse `openclaw.json` with a JSON5-lenient parser (ATO-87)*, the 2026-06-01
 ADR *Add a "Launch" page …*;
 files: [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 (`off_path_candidates`, `detect_agent_installed`, `install_agent`,
 `launch_openclaw_app`, `openclaw_patch_config`),
 [`src-tauri/src/core/cli/integrations.rs`](src-tauri/src/core/cli/integrations.rs),
 [`src-tauri/src/bin/jan-cli.rs`](src-tauri/src/bin/jan-cli.rs),
 [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx),
 [`web-app/src/stores/launch-store.ts`](web-app/src/stores/launch-store.ts).
