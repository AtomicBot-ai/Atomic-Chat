---
date: 2026-11-24
title: 'Turn the account on in release builds'
---

# 2026-11-24 — Turn the account on in release builds

- **Context:** `PlatformFeature.ACCOUNTS` kept the account (sign-in, the `/account/` section, the
  onboarding `account` step and remote access through the account) in desktop dev builds only
  ([2026-11-10](2026-11-10-sign-in-to-an-atomic-chat-account.md),
  [2026-11-11](2026-11-11-give-the-account-its-own-section-and-an-onboarding-step.md),
  [2026-11-12](2026-11-12-share-and-use-models-through-the-account.md)). Those records named the
  conditions for release: translations beyond en/fr, a run in the real Tauri window, and shipped
  chat sync and remote access clients.
- **Decision:** the flag is on for every desktop build, release included; iOS, Android and the web
  build stay off. The team chose to ship it now rather than wait for the remaining conditions.
- **Consequences:**
  - Account strings exist in en, fr and ru only; the other locales show English until translated.
  - The onboarding `account` step still promises private chat sync, whose desktop client has not
    shipped (the backend sync API is atomic-chat-backend PR #3). Drop or reword that card if sync
    does not land soon.
  - Remote access through the account needs core v0.23.0 or later (`PUT /server/client-keys`);
    the app pins a newer core.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/platform/const.ts`; AtomicBot-ai/Atomic-Chat#410.

<!--
Supersedes: the "Release gate" clause of 2026-11-10-sign-in-to-an-atomic-chat-account.md and the
"before the accounts flag leaves dev builds" consequence of
2026-11-11-give-the-account-its-own-section-and-an-onboarding-step.md
-->
