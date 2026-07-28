---
date: 2026-06-16
title: "Switch macOS autostart from `LaunchAgent` to `AppleScript` (real Login Item) + one-time choice-preserving migration for existing users"
---

# 2026-06-16 — Switch macOS autostart from `LaunchAgent` to `AppleScript` (real Login Item) + one-time choice-preserving migration for existing users

- **Context:** User report — the "Launch at startup" toggle exists (ATO-96 +
 the 2026-06-10 default-ON seed), but on macOS the app does **not** start on
 reboot and does not appear in `System Settings → General → Login Items →
 "Open at Login"`. Root cause: the autostart plugin was registered with
 `MacosLauncher::LaunchAgent`
 ([`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)). Confirmed against the crate
 sources: `tauri-plugin-autostart` 2.5.1 → `auto-launch` 0.5.0
 (`src/macos.rs`) — LaunchAgent mode writes
 `~/Library/LaunchAgents/{app_name}.plist` (`{app_name}` =
 `app.package_info().name`, here `"Atomic Chat"`; `RunAtLoad=true`) instead of
 registering a Login Item. So (a) it never shows under "Open at Login" (it can
 only appear under "Allow in the Background"), and (b) if autostart was ever
 enabled from a **dev** build, the plist's `ProgramArguments` points at the
 `target/debug` binary, which doesn't exist after a normal reboot → launchd
 can't launch it. The earlier ADR (ATO-96) chose LaunchAgent deliberately to
 avoid the Apple Events prompt.
- **Decision (per the user's chosen option — AppleScript Login Item, with a
 migration that preserves prior on/off choice):**
 1. **Launcher switch.** `MacosLauncher::LaunchAgent` →
 `MacosLauncher::AppleScript` in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs).
 AppleScript mode registers a real Login Item via `osascript`
 (`make login item …`), visible in System Settings and started by
 `loginwindow` on reboot. Trade-off (accepted): a one-time
 automation-permission prompt on first enable.
 2. **Choice-preserving migration (macOS only, one-shot).** New Rust command
 `migrate_macos_autostart_launchagent`
 ([`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs),
 registered in both `generate_handler!` lists in
 [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)): resolves the **exact** legacy
 plist path from `app.package_info().name` (the same value the plugin used, so
 the filename matches by construction), and if `~/Library/LaunchAgents/{app_name}.plist`
 exists — i.e. the user had launch-at-startup **ON** under the old launcher —
 best-effort `launchctl unload`s it, removes it (so it can't double-launch or
 point at a stale binary), and returns `true`; otherwise returns `false`
 (and `false` on non-macOS). Frontend
 ([`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx)):
 a new `IS_MACOS`-gated effect, guarded by a one-shot localStorage flag
 `autostart-applescript-migrated`
 ([`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts)),
 calls the command; when it reports a prior ON, re-registers the Login Item via
 `enableAutostart()` (guarded by `!isAutostartEnabled()`), so the user **keeps**
 autostart — now as a Login Item. A user who had it **off** has no legacy plist
 → no-op → choice preserved. New users are covered by the existing default-ON
 seed (which now creates an AppleScript Login Item); the migration is a no-op
 for them.
- **Consequences:** Existing macOS users who had autostart enabled keep it (now
 a reboot-reliable Login Item visible in System Settings); those who disabled it
 stay disabled; new users get the Login Item by default. The stale LaunchAgent
 plist is cleaned up so it can't double-launch alongside the Login Item. Scope:
 1 Rust command + the launcher line + 1 web-app effect + 1 localStorage key; no
 IPC shape change beyond the additive command, no on-disk layout or settings
 schema change. Windows/Linux unaffected (the command returns `false` off
 macOS; their autostart paths are unchanged). **Verified:**
 `cargo check -p Atomic-Chat` 0 errors (pre-existing `dead_code` warnings only);
 `eslint` clean on the two touched web-app files; `tsc -b` shows only the
 pre-existing, unrelated `jsonrepair` missing-module error (dependency declared
 in `package.json` but not installed in the sandbox), nothing from the edited
 files. **Caveat:** first enable triggers the macOS automation-permission
 prompt; the migration is keyed on localStorage, so a cleared localStorage /
 factory reset re-runs it once (harmless — it re-detects the real plist state).
- **Owner:** team.
- **Links:** [ATO-96](https://linear.app/atomicchat/issue/ATO-96), the 2026-06-09
 ADR *Add a cross-platform "Launch at startup" toggle …* and the 2026-06-10 ADR
 *Default "Launch at startup" to ON for all users …*,
 [`tauri-plugin-autostart` 2.5.1](https://crates.io/crates/tauri-plugin-autostart) /
 `auto-launch` 0.5.0 (`src/macos.rs`), files:
 [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)
 (`MacosLauncher::AppleScript`, command registration),
 [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 (`migrate_macos_autostart_launchagent`),
 [`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx)
 (migration effect),
 [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts)
 (`autostartAppleScriptMigrated`).
