---
date: 2026-08-05
title: "Keep launch at startup opt-in and ignore development binaries"
---

# 2026-08-05 — Keep launch at startup opt-in and ignore development binaries

- **Context:** The one-time startup seed introduced on 2026-06-10 enabled OS
  autostart without consent. Clearing local storage caused it to run again,
  overriding users who had disabled Atomic Chat through Windows, while Tauri
  development builds could register their temporary executable paths as login
  items.
- **Decision:** Remove the automatic seed and restore the original opt-in
  behavior: only the Settings toggle may enable autostart. Hide and bypass
  autostart management in development, including the macOS launcher migration,
  so a development executable cannot become an OS login item.
- **Consequences:** Clean installs and factory resets leave autostart off.
  Existing enabled entries remain enabled until the user disables them.
  Development builds cannot inspect, migrate, enable, or disable autostart;
  installed production builds retain the cross-platform toggle and the
  choice-preserving macOS migration.
- **Owner:** team.
- **Links:** [ATO-404](https://linear.app/atomicchat/issue/ATO-404),
  [2026-06-09 opt-in autostart decision](2026-06-09-add-a-cross-platform-launch-at-startup-toggle-via-tauri-plugin.md),
  [2026-06-10 default-on decision](2026-06-10-default-launch-at-startup-to-on-for-all-users-new-existing-one.md).

<!--
Supersedes: 2026-06-10-default-launch-at-startup-to-on-for-all-users-new-existing-one.md
-->
