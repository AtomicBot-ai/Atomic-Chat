---
date: 2026-06-09
title: "Add a cross-platform \"Launch at startup\" toggle via `tauri-plugin-autostart` (ATO-96)"
---

# 2026-06-09 — Add a cross-platform "Launch at startup" toggle via `tauri-plugin-autostart` (ATO-96)

- **Context:** A Discord user (Andrej) asked whether Atomic Chat can be
  configured to run at system startup; no such option existed. Investigation
  confirmed there was **no** autostart mechanism anywhere — no
  `tauri-plugin-autostart` in [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml),
  no plugin registration in [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs), no
  UI control (the only `*Startup*` symbol in the codebase is the unrelated
  `preloadModelOnStartup`). Requirement: a cross-platform (macOS / Windows /
  Linux) toggle in Settings → General.
- **Decision:** Use the official `tauri-plugin-autostart` v2 (under the hood
  the `auto-launch` crate: macOS Login Items / LaunchAgent, Windows
  `HKCU\…\Run` registry key, Linux `~/.config/autostart/*.desktop`). MVP only —
  exactly the ticket's scope.
  1. **Rust** ([`Cargo.toml`](src-tauri/Cargo.toml),
     [`lib.rs`](src-tauri/src/lib.rs)): `tauri-plugin-autostart = "2.5.1"` added
     to the **desktop-only** target block
     (`cfg(not(any(target_os = "android", target_os = "ios")))`, beside
     `tauri-plugin-single-instance` / `tauri-plugin-updater`) so it is never
     compiled on mobile. Registered inside the existing `#[cfg(desktop)]` block
     **after** `single_instance` (the plugin requires single-instance first),
     with `MacosLauncher::LaunchAgent` (avoids the Apple Events prompt) and
     `None` launch args.
  2. **Capabilities:** `"autostart:default"` (covers
     `allow-enable` / `allow-disable` / `allow-is-enabled`) added to
     [`capabilities/default.json`](src-tauri/capabilities/default.json) and
     [`capabilities/desktop.json`](src-tauri/capabilities/desktop.json).
  3. **TS** ([`web-app/package.json`](web-app/package.json)):
     `@tauri-apps/plugin-autostart@2.5.1`.
  4. **UI** ([`general.tsx`](web-app/src/routes/settings/general.tsx)): a
     `CardItem` + `Switch` in the General card, gated behind `IS_TAURI`. The
     **OS is the source of truth** — state comes from a direct `isEnabled()`
     query on mount; the toggle calls `enable()` / `disable()` then re-reads
     `isEnabled()`. No localStorage/zustand mirror (avoids drift if the user
     removes the autostart entry externally). On error a toast
     (`settings:general.launchAtStartupError`) is shown and the switch is
     reconciled to the real OS state.
  5. **i18n:** `launchAtStartup` / `launchAtStartupDesc` /
     `launchAtStartupError` in
     [`en/settings.json`](web-app/src/locales/en/settings.json) and
     [`ru/settings.json`](web-app/src/locales/ru/settings.json); other locales
     fall back to EN.
- **Consequences:** Default is **OFF** — the plugin creates no autostart entry
  unless the user flips the toggle; there is no auto-`enable()` on first launch.
  Desktop-only (gated by both the Cargo target and `IS_TAURI`); mobile is
  unaffected. **Out of scope (not built):** hidden/tray start on autostart
  (would need an `--autostart` launch arg + hidden-window logic) and any
  localStorage mirroring. **Cross-platform caveat to confirm at smoke-test:** on
  Linux AppImage, `auto-launch` relies on the `APPIMAGE` env var to write the
  correct exec path into the `.desktop` file — verify the generated
  `~/.config/autostart/Atomic Chat.desktop` points at the AppImage, not an
  extracted temp path.
- **Owner:** team.
- **Links:** [ATO-96](https://linear.app/atomicchat/issue/ATO-96), §5 *Build &
  dev workflow*, files:
  [`src-tauri/Cargo.toml`](src-tauri/Cargo.toml),
  [`src-tauri/src/lib.rs`](src-tauri/src/lib.rs),
  [`src-tauri/capabilities/default.json`](src-tauri/capabilities/default.json),
  [`src-tauri/capabilities/desktop.json`](src-tauri/capabilities/desktop.json),
  [`web-app/package.json`](web-app/package.json),
  [`web-app/src/routes/settings/general.tsx`](web-app/src/routes/settings/general.tsx),
  [`web-app/src/locales/en/settings.json`](web-app/src/locales/en/settings.json),
  [`web-app/src/locales/ru/settings.json`](web-app/src/locales/ru/settings.json).
