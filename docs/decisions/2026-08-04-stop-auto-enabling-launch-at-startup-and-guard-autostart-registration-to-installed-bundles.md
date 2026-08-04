---
date: 2026-08-04
title: "Stop auto-enabling launch at startup and guard autostart registration to installed bundles"
---

# 2026-08-04 — Stop auto-enabling launch at startup and guard autostart registration to installed bundles

- **Context:** Bug report ATO-404 showed that the one-time default-ON seed added in
  the 2026-06-10 ADR was flipping the autostart default for all users without
  asking, including after a factory reset (where the localStorage seed flag is
  wiped). On Windows, re-enabling also overwrote the OS-level disable flag
  written by Task Manager, and on macOS a dev/uninstalled binary could register
  itself instead of the bundled `.app`.
- **Decision:** Revert the automatic seeding. The autostart toggle stays in
  Settings → General, but it now defaults to **OFF** for everyone. The only
  automatic re-enable path left is the macOS LaunchAgent → AppleScript migration,
  and it is guarded by a new Rust command that refuses to register autostart in
  debug builds and on macOS when the executable is not inside a bundled `.app`.
- **Consequences:**
  - New installs, existing users, and post-factory-reset users will not have an
    autostart entry created unless they explicitly toggle it ON.
  - Windows users who disabled the app via Task Manager will no longer have that
    choice overwritten by an automatic `enable()` call.
  - macOS dev builds and uninstalled binaries will not create dangling or
    unremovable Login Items; only the installed `.app` can register.
  - The `autostart-seeded` localStorage key is retired; it is kept in the
    constants file only to avoid reusing the legacy slot.
- **Owner:** team.
- **Links:**
  - Supersedes: [2026-06-10 — Default "Launch at startup" to ON for all users](2026-06-10-default-launch-at-startup-to-on-for-all-users-new-existing-one.md)
  - Related: [2026-06-09 — Add a cross-platform "Launch at startup" toggle](2026-06-09-add-a-cross-platform-launch-at-startup-toggle-via-tauri-plugin.md),
    [2026-06-16 — Switch macOS autostart to AppleScript Login Item](2026-06-16-switch-macos-autostart-from-launchagent-to-applescript-real.md)
  - Issue: [ATO-404](https://linear.app/atomicchat/issue/ATO-404)
  - Files: [`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx),
    [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts),
    [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs),
    [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs)
