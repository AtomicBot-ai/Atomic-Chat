---
date: 2026-08-19
title: "Leave launch at startup off for new installs"
---

# 2026-08-19 — Leave launch at startup off for new installs

- **Context:** `AppConfiguration::new_install()` wrote `pending_default_on`, so
  the first launch of a fresh install added Atomic Chat to the OS login items
  (ADR 2026-08-05). Paired with model preloading, that meant a machine reboot
  silently started the app and loaded a model. Claiming a login item is a
  decision about the user's whole session, and we should not make it for them.
- **Decision:** `new_install()` now yields `Unmanaged`, the same preference an
  upgraded configuration gets. No install enables autostart on our behalf; the
  Settings → General toggle is the only way in. The `PendingDefaultOn` variant
  and its branch in `reconcileLaunchAtStartup` stay, so configurations written
  by older builds still deserialize and complete the contract they were created
  under. Existing installs are not touched: whatever the OS currently holds
  stays, and users turn it off themselves.
- **Consequences:** new installs no longer appear in Login Items / Task Manager
  without being asked, and reboot no longer costs a background app plus a model
  load. The trade-off is that users who wanted autostart now have to find the
  toggle. `PendingDefaultOn` becomes unreachable for newly written configs — it
  is retained purely for deserialization compatibility and should be removed
  once no shipped build can still emit it.
- **Owner:** `team`
- **Links:** `src-tauri/src/core/app/models.rs`,
  `web-app/src/lib/launchAtStartup.ts`,
  [model preload companion decision](2026-08-19-do-not-preload-a-model-on-startup.md)

<!--
Supersedes: 2026-08-05-default-autostart-on-only-for-clean-desktop-installs.md
-->
