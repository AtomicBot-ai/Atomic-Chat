---
date: 2026-10-30
title: "Correct the Windows publisher without changing installation identity"
---

# 2026-10-30 — Correct the Windows publisher without changing installation identity

- **Context:** Microsoft Store rejected Atomic Chat under policy 10.2.7 because
  its Add/Remove Programs identity did not match the submission. `bundle.publisher`
  was `Spaceship Intelligence`, while the Store publisher is `Atomic Mail Systems`.
  Tauri also uses the publisher for the NSIS install-location registry namespace
  and for detecting an MSI installation before switching it to NSIS.
- **Decision:** Set `bundle.publisher` to `Atomic Mail Systems`. Activate the
  existing `tauri.bundle.windows.nsis.template` path, replacing its unused,
  previously rendered contents with the upstream tauri-cli 2.8.4 Handlebars
  template plus two compatibility changes:
  - Keep the internal `Software\Spaceship Intelligence\Atomic Chat` key for
    reading/writing the install directory and installer language. This retains
    custom install directories, the old uninstaller's directory lookup, explicit
    `/D` behavior, and the existing uninstall cleanup without a registry migration.
  - Match either the current or legacy publisher when detecting an Atomic Chat
    MSI. Keep the existing pinned WiX `upgradeCode` for MSI-to-MSI upgrades.
  The displayed Publisher still comes from the new bundle publisher; product
  name, bundle identifier, uninstall key and application data paths do not change.
- **Verification:** The Windows x64 release job checks the base publisher and
  rejects conflicting Windows/Store/ARM64 overrides before building.
  `scripts/verify-windows-installer.ps1` now fails on any
  Publisher other than exactly `Atomic Mail Systems`, or on duplicate uninstall
  entries. On a clean Windows profile, `-LegacyInstaller old.exe` first installs
  the previous NSIS build into a unique directory containing spaces, then runs
  the new installer without `/D`. It requires the same directory and uninstall
  entry afterwards and runs the existing signature, launch and removal checks.
  Run it once with the default `-UpgradeMode Updater` (`/S /P /UPDATE`) and once
  with `-UpgradeMode Installer` (`/S /P`), using a newer version as `-Installer`.
  A regular invocation still tests a fresh install.
- **Consequences:** All Windows NSIS variants, including the Store and ARM64,
  inherit the template. Rebase its two compatibility changes when updating Tauri;
  do not reuse the old machine-specific rendered template. The old publisher
  remains an internal compatibility identifier only. Actual install/upgrade
  acceptance requires Windows and the signed old/new EXEs.
- **Owner:** team.
- **Links:** `src-tauri/tauri.conf.json`, `src-tauri/tauri.bundle.windows.nsis.template`,
  `scripts/verify-windows-installer.ps1`,
  [Tauri 2.8.4 template](https://github.com/tauri-apps/tauri/blob/tauri-cli-v2.8.4/crates/tauri-bundler/src/bundle/windows/nsis/installer.nsi).

Supersedes the decision to leave `bundle.publisher` unchanged in
[2026-10-22 — Sign every Windows PE file](2026-10-22-sign-every-windows-pe-via-tauri-signcommand-and-ship-an-msstore-installer.md).
