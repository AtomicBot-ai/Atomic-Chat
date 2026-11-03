---
date: 2026-10-26
title: 'Show notifications as allowed only once the user allows them in setup'
---

# 2026-10-26 — Show notifications as allowed only once the user allows them in setup

- **Context:** The first-run permissions step read the OS answer for
  notifications on arrival and showed the row as "Allowed" when it said
  granted. Tauri's desktop notification plugin (2.3.3) answers "granted" on
  every desktop OS without asking anyone, so the row was always allowed, the
  button read Continue, and leaving with nothing allowed never showed the
  "Continue without permissions?" warning (2.2.26 feedback).
- **Decision:** The notifications row shows only the answer given in this
  run: Allow until the user allows it through the explanation dialog.
  `notificationPermissionGranted` is removed. The microphone row keeps
  reading the OS, whose answer is real.
- **Consequences:** With nothing allowed the button reads Skip and leaving
  asks first, as in the prototype. Someone who allowed notifications in an
  earlier install sees Allow again; pressing it is instant, since the plugin
  answers granted. Revisit if the plugin starts reporting real OS state.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/onboarding/steps/PermissionsStep.tsx`,
  `web-app/src/lib/notifications.ts`, `tauri-plugin-notification`
  `src/desktop.rs` (`permission_state` returns `Granted`).
