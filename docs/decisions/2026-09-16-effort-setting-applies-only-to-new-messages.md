---
date: 2026-09-16
title: "The effort setting applies only to new messages; a stored message renders the parts it has"
---

# 2026-09-16 — The effort setting applies only to new messages; a stored message renders the parts it has

- **Context:** The reasoning-effort setting (`useGeneralSetting.disableReasoning`
  / `reasoningBudget`, driven from the composer's model pill slider and from
  Settings → General) was read in two places. The request side —
  `custom-chat-transport.ts` and `buildAgentReasoningRequest` in
  `reasoning-effort.ts` — decides per request whether thinking is asked for.
  The render side — `MessageItem` subscribing to `disableReasoning` and passing
  it to `buildTraceBlocks`, which dropped `reasoning` parts while the toggle was
  on — was a workaround for providers (MiniMax was the example) that keep
  streaming chain-of-thought even when told not to. That second read made the
  transcript depend on the current setting: dragging the slider on a thread
  chatted with effort Off made a "Reasoned" collapsible appear above old
  answers, the content shifted, and the stick-to-bottom conversation container
  (`resize="instant"`) snapped to the bottom so the user's own earlier message
  scrolled out of view. Dragging back to Off undid it. Danny's rule: the
  effort setting must have no effect on the conversation already on screen.
- **Decision:** Reasoning visibility is a property of the message, never of a
  setting. `buildTraceBlocks(message, options)` loses its `disableReasoning`
  parameter and always projects the `reasoning` parts a message carries;
  `MessageItem` no longer subscribes to the general-setting store at all, so a
  setting change does not re-render or reflow any message. The request-side
  decision is untouched: from now on the setting applies to the next message
  sent and to the answer it produces. The MiniMax render-time workaround is
  dropped rather than moved.
- **Consequences:** The transcript is stable under the slider — no layout
  shift, no scroll jump, no message disappearing — and old answers that were
  produced with reasoning keep showing it, even after the user turns reasoning
  off. Trade-off: a provider that ignores the thinking flag and streams
  chain-of-thought anyway will now show it as a "Reasoned" block while the
  setting says Off. That is the honest rendering of what the provider sent; if
  it needs hiding, do it once at receive time (decide when the answer streams
  in, from the setting at that moment, and store the result on the message —
  the transport is the place), never at render time. `buildTraceBlocks` had a
  single production caller (`MessageItem`), so the signature change is local.
- **Owner:** @danyurkin.
- **Links:** `web-app/src/lib/tools/message-trace-parts.ts`,
  `web-app/src/containers/MessageItem.tsx`,
  `web-app/src/containers/__tests__/MessageItem.reasoning.test.tsx`,
  `web-app/src/lib/tools/message-trace-parts.test.ts`,
  `web-app/src/components/ai-elements/conversation.tsx` (stick-to-bottom
  container that turned the reflow into a scroll jump); related:
  [2026-09-11 — Pick the model and its reasoning effort from one composer pill](2026-09-11-pick-the-model-and-its-effort-from-one-composer-pill.md),
  [2026-08-12 — Render reasoning as its own block outside the activity block](2026-08-12-render-reasoning-as-its-own-block-outside-the-activity-block.md).
