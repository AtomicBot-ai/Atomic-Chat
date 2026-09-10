---
date: 2026-08-05
title: "Default autostart on only for clean desktop installs"
---

# 2026-08-05 — Default autostart on only for clean desktop installs

- **Context:** Product requires launch at startup to default to ON for new
  desktop installations without repeating the localStorage seed that
  re-enabled autostart after users disabled it. Existing installations must
  retain their OS state, and Factory Reset must preserve the user's choice.
- **Decision:** Persist an autostart preference in `settings.json`. A newly
  created configuration starts as `pending_default_on`; a pre-existing
  configuration with no field deserializes as `unmanaged` and adopts its
  current OS state without changing it. After initialization, the OS state is
  authoritative, so changes made through Windows Task Manager or macOS Login
  Items are recorded rather than reversed. Factory Reset carries the
  preference into the replacement configuration. Development and mobile
  builds do not participate.
- **Consequences:** New macOS, Windows, and Linux desktop installations enable
  autostart once. Upgrades do not silently enable it. The Settings toggle
  verifies the applied OS state before persisting it. The upstream Linux
  plugin still detects only whether its `.desktop` file exists, so desktop
  environments that disable entries by editing metadata can report stale
  state until custom Linux detection is added.
- **Owner:** team.
- **Links:** [ATO-404](https://linear.app/atomicchat/issue/ATO-404),
  [2026-08-05 opt-in decision](2026-08-05-keep-launch-at-startup-opt-in-and-ignore-development-binaries.md).

<!--
Supersedes: 2026-08-05-keep-launch-at-startup-opt-in-and-ignore-development-binaries.md
-->
