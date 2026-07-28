---
date: 2026-06-10
title: "Default \"Launch at startup\" to ON for all users (new + existing), one-time seed, still user-disable-able"
---

# 2026-06-10 — Default "Launch at startup" to ON for all users (new + existing), one-time seed, still user-disable-able

- **Context:** The ATO-96 autostart feature shipped with the default **OFF**
 (the plugin created no autostart entry unless the user flipped the
 Settings → General toggle; there was deliberately no auto-`enable()` on first
 launch). Product wants autostart **ON by default for everyone** — both fresh
 installs and existing users on update — while preserving the ability to turn
 it off in Settings.
- **Decision:** Add a one-time **seed** at app startup. New localStorage key
 `autostartSeeded` (`'autostart-seeded'`) in
 [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts).
 A new `IS_TAURI`-gated effect in
 [`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx)
 (mounted at app root, runs once on startup) checks the seed flag; if unset it
 calls `enable()` from `@tauri-apps/plugin-autostart` when autostart isn't
 already on, then records the flag. The flag is set **only after** autostart is
 confirmed on (already-enabled or successful `enable()`), so a transient
 failure retries on the next launch, and — critically — once seeded a later
 manual **disable** in Settings is never re-enabled. The existing
 Settings → General toggle ([`general.tsx`](web-app/src/routes/settings/general.tsx))
 still reads the OS as source of truth and is unchanged.
- **Consequences:**
 - Fresh installs and existing users (on the first launch after this ships)
 get autostart turned ON automatically, exactly once. Users who then disable
 it keep it disabled (seed flag already set). Users who had **manually**
 enabled it before are unaffected (seed sees it already on, just records the
 flag).
 - **Reverses the ATO-96 "default OFF / no auto-enable on first launch"
 decision.** Desktop-only (gated by `IS_TAURI`); mobile unaffected. No Rust,
 capability, or schema change — purely a web-app startup seed reusing the
 already-registered `tauri-plugin-autostart`. Lint-clean on both touched files.
 - **Caveat:** the seed is keyed on localStorage, so a factory reset / cleared
 localStorage re-seeds (re-enables) autostart once — acceptable given the new
 default is ON anyway.
- **Owner:** team.
- **Links:** [ATO-96](https://linear.app/atomicchat/issue/ATO-96), the
 2026-06-09 ADR *Add a cross-platform "Launch at startup" toggle …*, files:
 [`web-app/src/providers/DataProvider.tsx`](web-app/src/providers/DataProvider.tsx),
 [`web-app/src/constants/localStorage.ts`](web-app/src/constants/localStorage.ts),
 [`web-app/src/routes/settings/general.tsx`](web-app/src/routes/settings/general.tsx).
