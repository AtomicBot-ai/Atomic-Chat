---
date: 2026-09-13
title: "Rename the product to Radium and move the default data folder"
---

# 2026-09-13 — Rename the product to Radium and move the default data folder

- **Context:** 502bbc5e1 (tracker decision D13) renamed what users read to
  "Radium Chat" but deliberately left `productName` as "Atomic Chat". The
  installer, Start menu and Apps list therefore still said Atomic Chat, and so
  did the data folder (`%APPDATA%\Atomic Chat\data`). The deferral was on
  purpose: the default data folder derives from `productName`, and its absolute
  path is saved in `settings.json`, so a plain rename points a build at an empty
  folder and looks exactly like data loss. On 2026-09-13 the user set the name:
  "Radium, NOT Radium Chat. Update everything, retain all previous code where
  possible, especially media."
- **Decision:** the product is **Radium**. `productName` becomes "Radium" and
  every name a user reads becomes Radium, in the same change as the migration
  that makes it safe.
  - **Data folder.** On launch, before anything opens a file in it,
    `core/app/data_migration.rs` moves the old default data folder to
    `<data_dir>/Radium/data` with one same-volume `rename`. It then points every
    existing `settings.json` (identifier folder and legacy `CARGO_PKG_NAME`
    folder) at the new path.
    - **Two old names.** "Atomic Chat" is the shipped one. "Radium Chat" was
      `jan-cli`'s fallback after D13 and can exist, usually empty.
    - **Which folder moves.** The one the settings in effect name. With no
      settings, the one old folder that holds data. With two such folders
      neither moves, because picking one would hide the other.
    - **Never touched.** A custom data folder, and a new location that already
      holds data. Only empty dirs and 0-byte files are ever deleted. A failed
      rename or settings write puts everything back, to retry next launch.
  - **Installer.** A new `NSIS_HOOK_PREINSTALL` silently uninstalls an
    existing "Atomic Chat" install first, NSIS (by its uninstall key) or MSI (by
    DisplayName and Publisher). Tauri looks for previous installs by the current
    `productName`, so without it the new build installs side by side. Neither
    uninstaller removes user data in that mode. The WiX `upgradeCode` stays
    pinned (ADR 2026-05-22), so MSI installs still upgrade in place.
  - **Launch at startup.** The OS entry is named after `productName`.
    `migrate_legacy_autostart_entry` removes the "Atomic Chat" entry once
    (Windows `Run` value, macOS Login Item, Linux `.desktop`). The web app then
    re-enables autostart under the new name if that entry existed or the saved
    preference was on.
  - **CLI.** `jan-cli` no longer creates `%APPDATA%\Atomic-Chat` while
    resolving settings; it reads the same file the app does. Creating that
    folder had silently switched the app to the legacy settings file.
  - **What keeps its old name (tracker decision D24).** Internal names that hold
    data or upgrades:
    - the identifier `chat.atomic.app`, where WebView2 storage (settings,
      providers, cloud API keys) lives and which the MSI and notifications key on;
    - the binary `Atomic-Chat.exe` and its Cargo package;
    - `atomic-media-worker` and the `AtomicMedia*` types;
    - the markers and provider keys written into other tools' config files,
      which later edits use to find those blocks again;
    - external names: the atomic.chat domain, AtomicBot-ai upstream links and
      AtomicChat/ Hugging Face repositories.
  - **Media (tracker decision D25).** Radium Media keeps its name, and no media
    file is edited. Some media wording that still says "Radium Chat" stays until
    the user decides otherwise.
- **Consequences:**
  - An existing install keeps its threads, models and settings, now under
    `%APPDATA%\Radium\data`. The installer and uninstaller handle all three
    folder names.
  - A data folder the app could not move (a file locked by another process, a
    new location that already holds data, or two old folders that both do)
    stays where it is and keeps working, and the reason is logged at startup.
  - The move has been exercised on Windows. macOS and Linux share the code path
    and its unit tests, but not a real install.
- **Owner:** `walladanger`
- **Links:** ADR 2026-05-19 (product identity), ADR 2026-05-22 (pinned WiX
  upgradeCode); tracker Task 21 and decisions D13, D23-D26;
  `src-tauri/src/core/app/data_migration.rs`, `src-tauri/windows/hooks.nsh`,
  `migrate_legacy_autostart_entry` in `src-tauri/src/core/system/commands.rs`,
  `web-app/src/lib/launchAtStartup.ts`, `tests/radium-product-name.test.mjs`
