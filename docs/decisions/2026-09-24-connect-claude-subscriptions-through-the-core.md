---
date: 2026-09-24
title: "Connect Claude subscriptions through the core-owned official CLI"
---

# 2026-09-24 — Connect Claude subscriptions through the core-owned official CLI

- **Context:** Users want to use their Claude plan in Atomic Chat. The core migration branch owns desktop runtimes outside Tauri; a second CLI process owner in Rust would reverse that boundary.
- **Decision:** The companion `atomic-chat-core` change owns discovery, official CLI login, streaming and cancellation. Tauri sends authenticated control requests and relays request-scoped SSE into a private IPC channel. The Cloud page and onboarding offer a Claude subscription connection alongside ChatGPT. An existing official CLI login is reused; otherwise the CLI opens its own browser sign-in. The official native CLI must already be installed. Atomic never reads, stores or forwards Claude account credentials.
- **Consequences:** The CLI model catalog supplies exact versions, including Fable, and context variants. The model shown is the resolved model passed to the CLI, including the default row. Old family aliases migrate without duplicating unversioned entries. Subscription requests bypass the public OpenAI-compatible proxy, and never fall back to API-key billing. This first integration is text-only: file/MCP tools, attachments, partial continuation and unsupported reasoning controls are unavailable. Disabling the connection hides it in Atomic without logging the user out of their shared CLI session. Fable can use usage credits under Anthropic's plan rules.
- **Release dependency:** Requires a core build containing `/claude-code/status`, `/claude-code/login` and `/claude-code/chat`. The current app pin remains 0.4.0 until the core maintainers publish the companion change; this app PR must stay draft until its core pin can be updated to that published release. Missing routes produce an explicit upgrade error, not a fallback credential path.
- **Owner:** team.
- **Links:** [Claude Code programmatic interface](https://code.claude.com/docs/en/headless), [integration conditions](https://code.claude.com/docs/en/legal-and-compliance), [model configuration and billing](https://code.claude.com/docs/en/model-config).

## Verification

- Frontend typecheck, build and lint pass. The feature tests cover versioned catalog migration, routing around the HTTP model factory, cancellation races, unsupported inputs, failure propagation and session continuity.
- Browser geometry checks cover 1024/1280 widths, Medium/Extra Large fonts, and light/dark themes.
- Rust tests dispatch the real status/cancel IPC commands, verify request-scoped cancellation, and exercise the authenticated core stream. An opt-in Rust test emits the shared fixtures.
- The full app test suite has unchanged baseline failures in the video poster test and the Node/jsdom Request/AbortSignal retarget test. `make verify` also stops on baseline quality-guard violations in video/download tests and evidence links, reproduced from a clean archive of the migration branch. The complete layout suite hit a Vitest browser harness error; the new card's focused matrix passes.
- `tests/e2e/desktop/claude-subscription.spec.ts` is the isolated native-app acceptance scenario. It requires the companion core build and a dedicated app-e2e build; it is not claimed as run by the tests above.
