---
date: 2026-05-22
title: "Pin static WiX `upgradeCode` to legacy Jan UUID for in-place MSI upgrades"
---

# 2026-05-22 — Pin static WiX `upgradeCode` to legacy Jan UUID for in-place MSI upgrades

- **Context:** Installing a newer Atomic Chat MSI on top of an existing Jan
  MSI (or, transitively, on top of an older Atomic Chat MSI built before this
  change) produced a side-by-side install instead of an in-place upgrade
  ([GitHub issue #11](https://github.com/AtomicBot-ai/Atomic-Chat/issues/11)).
  Root cause: Tauri 2 derives the WiX `UpgradeCode` from `productName` as
  `UUIDv5("<productName>.exe.app.x64")`. The Jan → Atomic Chat rebrand
  changed `productName` from `"Jan"` to `"Atomic Chat"`, which silently
  switched the derived UpgradeCode from `b75dd42f-800c-57cb-8c5c-ed7fcbef13a0`
  to `e66a76fe-8004-5158-ab35-98fc7d71e98d`, breaking Windows Installer's
  `MajorUpgrade` match.
- **Decision:** Set `bundle.windows.wix.upgradeCode =
  "b75dd42f-800c-57cb-8c5c-ed7fcbef13a0"` in `src-tauri/tauri.windows.conf.json`
  — the legacy Jan UUIDv5. From now on every Atomic Chat MSI carries this
  pinned UpgradeCode and is independent of any future `productName` rename.
  Verified via `npx tauri inspect wix-upgrade-code`:
  `Application Upgrade Code override: b75dd42f-…`.
- **Consequences:**
  - **Jan MSI → Atomic Chat MSI** now upgrades in place (Windows Installer
    sees the matching `UpgradeCode`, runs `MajorUpgrade`, removes Jan, and
    installs Atomic Chat into the same slot). Fixes #11 for that path.
  - **Atomic Chat MSI v_N → v_{N+1}**, both built after this ADR, upgrades
    in place forever, regardless of future rebrands.
  - **Atomic Chat MSI built before this ADR** (already shipped with the
    derived `e66a76fe-…` UpgradeCode) → Atomic Chat MSI built after this
    ADR will install side-by-side **once**. Users on those MSI builds must
    manually uninstall the old "Atomic Chat" entry from Programs & Features
    before the new MSI takes its place. The README and the auto-updater
    both use the NSIS channel, so the MSI install base is small.
  - NSIS channel and auto-updater are unaffected (NSIS detects previous
    installs via `Software\…\Uninstall\{ProductName}`, which is governed by
    `productName`, not `UpgradeCode`).
  - If the one-time side-by-side proves painful, a follow-up ADR may add a
    custom WiX fragment via `wix.fragmentPaths` containing an extra
    `<Upgrade Id="e66a76fe-8004-5158-ab35-98fc7d71e98d">` block that also
    detects and removes the old derived-UpgradeCode product. Not in this ADR.
- **Owner:** team.
- **Links:** [GitHub issue #11](https://github.com/AtomicBot-ai/Atomic-Chat/issues/11),
  `src-tauri/tauri.windows.conf.json`.
