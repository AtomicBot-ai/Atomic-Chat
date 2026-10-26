---
date: 2026-10-26
title: "Chat with the team through a support relay, with diagnostics attached"
---

# 2026-10-26 — Chat with the team through a support relay, with diagnostics attached

- **Context:** Help offered email, Discord and a GitHub issue, all of which take the user out of
  the app and make the team ask what they run. The redesign prototype adds Help → Chat with us: a
  right-side sheet where the user writes to the team and reads the answers. The team works in a
  Telegram group; the app must not hold a bot token or talk to Telegram itself.
- **Decision:** the app talks only to our support relay
  ([AtomicBot-ai/atomic-support-bot](https://github.com/AtomicBot-ai/atomic-support-bot), whose
  README holds the API contract; `SUPPORT_API_URL`, default
  `https://hatchet.atomic.chat/support`, `VITE_SUPPORT_API_URL` to override), which forwards to
  Telegram and returns replies. API v1: a conversation created lazily on the first send returns a
  bearer token; messages carry a client UUID the relay deduplicates on, so Retry is safe; a long
  poll returns changes after a `seq` (edits and deletions come back under a new `seq`, upserted by
  id); `POST /v1/read` reports what was read; 401 drops the conversation, 429 is shown inline.
  Diagnostics (app/core version, OS, arch, installer, CPU, RAM, GPUs, backend, selected provider
  and model, locale, timezone) are attached without a checkbox, with the conversation and again on
  a message whenever their fingerprint changes; the sheet says so under the composer. They follow
  the analytics zero-PII rule (no machine name, paths or GPU UUIDs); the PostHog distinct id goes
  along only while product analytics is on. Replies are always signed "Atomic Chat team".
  `useSupportChatSync`, mounted at the root, polls while a conversation exists and raises an OS
  notification for a new reply unless the chat is open in a focused window (the Settings switch
  still applies); while it is watched, replies are reported read instead.
- **Consequences:**
  - The relay must answer CORS for the app's webview origin; without it every request first fails
    in `fetch` and then goes through the Tauri HTTP plugin (remembered for the session).
  - The conversation, its token, the last 200 messages and undelivered messages persist in
    `atomic-support-chat`; a send cut short by a quit comes back as failed with Retry. A factory
    reset forgets the conversation.
  - v1 is text only: no attachments, badges or email fallback. A conversation the relay reports
    `closed` is not treated differently yet.
  - The hardware reads shared with analytics moved to `web-app/src/lib/hardware-summary.ts`; the
    analytics super-properties are unchanged.
- **Owner:** `team`.
- **Links:** `web-app/src/constants/support.ts`, `web-app/src/services/support/client.ts`,
  `web-app/src/services/support/diagnostics.ts`, `web-app/src/stores/support-chat-store.ts`,
  `web-app/src/hooks/useSupportChatSync.ts`, `web-app/src/containers/support/SupportChatSheet.tsx`,
  `web-app/src/components/left-sidebar/NavigationRail.tsx`, `web-app/src/lib/hardware-summary.ts`.
