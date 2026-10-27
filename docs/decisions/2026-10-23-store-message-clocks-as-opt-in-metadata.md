---
date: 2026-10-23
title: "Keep message clocks as opt-in metadata outside user text"
---

# 2026-10-23 — Keep message clocks as opt-in metadata outside user text

- **Context:** Users can give models current local date/time context without making a changing system clock invalidate the conversation prefix. Putting that context directly in saved user text also changes what users see, copy and edit. Removing the built-in `Current date: {{current_date}}` line would silently remove existing date context from users who never opt into the new feature.
- **Decision:** Keep the existing built-in instructions and date-template behavior in both frontend fallback and assistant extension. Add independent optional `include_date` and `include_time` assistant flags, both OFF by default, with no settings or history migration. New opted-in sends save selected local date/time strings in `metadata.message_clock`. Display explicit clock metadata above the bubble and reconstruct a deterministic prefix only at the model boundary.
- **Consequences:** Original user text, copy/edit behavior and older messages remain intact. Saved clocks are fixed across replay, regeneration and later setting changes. Model prompt prefixes can be reused when other instructions and history are unchanged. The legacy date template can still change the system text when the date changes, just as before; this feature does not promise unconditional cache hits.
- **Owner:** team.
- **Links:** `web-app/src/lib/messageClock.ts`, `web-app/src/lib/completion.ts`, `web-app/src/containers/MessageItem.tsx`, `web-app/src/lib/agent-session-sync.ts`.

## Compatibility boundary

The original default prompt remains `You are Atomic Chat, a helpful AI assistant.` followed by the existing blank line and `Current date: {{current_date}}`. OFF means no new message-level clock is captured; it does not disable that pre-existing template. Missing flags are treated as false. Existing assistants, customized prompts, sampling settings and historical messages are not rewritten. We do not automatically remove date templates when a switch is enabled, because a matching string can be deliberate user content and mixed-version clients still rely on the original prompt.

The new fields are additive assistant settings and message metadata. Model requests use ordinary text parts rather than a new provider-specific API field. Older clients can keep reading the original text without depending on the new feature for the default date context. No date-looking user text or old literal timestamp prefix is parsed or hidden.

## Capture, presentation and model requests

Capture one local clock snapshot when the new user message is persisted, after readiness/attachment preparation. Save only enabled fields. Date-only, time-only, both and neither are supported. Optimistic previews do not stamp an earlier time. Normal chat, deferred first sends and native agent sends follow this contract.

The UI renders captured metadata as a small muted label above the user bubble. Copy and inline editing operate on original user text; editing/regeneration do not recapture the clock. A later switch change affects future sends only. Previously saved labels and model context remain fixed.

The chat transport builds copies with the stored prefix before provider conversion; it does not mutate saved or displayed parts. Native agent invocation, regeneration and session reseeding reconstruct the same prefix. Attachment parts, tool results and failed-turn filtering retain their existing behavior. Legacy date templates remain raw until the actual transport send or native-agent invocation, preserving their format while avoiding stale dates in idle/deferred requests.
