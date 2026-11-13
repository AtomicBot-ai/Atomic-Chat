---
date: 2026-11-11
title: "Give the account its own section and an onboarding step"
---

# 2026-11-11 — Give the account its own section and an onboarding step

Supersedes the "rail avatar opens Settings → Account" clause of [Sign in to an Atomic Chat account from the desktop app](2026-11-10-sign-in-to-an-atomic-chat-account.md).

- **Context:** The account page sat under Settings, with the rail avatar opening it. The account is about to carry more than a profile: encrypted history sync and remote access will get screens of their own. New installs also never heard about the account unless they found the avatar.
- **Decision:**
  - **Own rail section.** The avatar opens `/account/` (`NavigationSection` `account`), lit while it is open. With one page there is no contextual sidebar, and the title bar hides the sidebar toggle there. Rows come back when sync or remote access add pages. Settings no longer lists Account.
  - **Onboarding step.** The full variant shows `account` after `media` and before `purpose`, because it serves both everyday use and the server path. Like the cloud and media steps it is optional: Skip goes on, and a signed-in run shows the account and Continue. It is gated by the accounts flag, and the experiment's `model_only` and `none` variants do not get it.
  - **One sign-in implementation.** `useAccountSignIn` holds the Google and email-code logic: providers, countdown, errors, cancelling a pending Google login on unmount. The settings card and the onboarding step each draw it in their own style; the step uses the shell's `ob-*` classes and tokens.
  - **Steady Devices card.** The list is cached in `account-store` for the signed-in user and cleared on sign-out or a user change. The loading placeholder is one row shaped like a device row, so the card keeps its height.
- **Consequences:**
  - The onboarding funnel gains a step: `onboarding_account_signed_in` carries `method`, and the step's `left` action is `continue` or `skip`.
  - The step promises chat sync and remote access. Their clients must ship before the accounts flag leaves dev builds.
  - The account strings now also exist in Russian. The other locales still fall back to English.
- **Owner:** `team`.
- **Links:** [AccountStep](../../web-app/src/containers/onboarding/steps/AccountStep.tsx), [steps](../../web-app/src/lib/onboarding/steps.ts), [useAccountSignIn](../../web-app/src/containers/account/useAccountSignIn.ts), [account route](../../web-app/src/routes/account/index.tsx), PR AtomicBot-ai/Atomic-Chat#410.
