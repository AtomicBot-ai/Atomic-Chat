---
date: 2026-09-09
title: "Resolve the reply model on send instead of asking (ATO-461)"
---

# 2026-09-09 — Resolve the reply model on send instead of asking (ATO-461)

- **Context:** `preloadModelOnStartup` is off by default
  ([2026-08-19](2026-08-19-do-not-preload-a-model-on-startup.md)) and
  `main.tsx` cleared the persisted selection on every boot, so "nothing
  selected" was the state of every cold launch — for a user with one model on
  disk, for a user with five, and for a user whose last session ran on a cloud
  key. Pressing Send from that state opened the "what do I reply with?" widget
  ([2026-09-07](2026-09-07-answer-a-blocked-send-with-a-widget-not-a-red-line.md))
  even when the device already knew the answer, and the widget's own
  one-model branch showed a modal to say it was starting the only model it
  could have started. A cloud user was asked again every launch what they had
  answered the day before.
- **Decision:** the composer decides first and asks second. On a send with no
  selection, `useReplyModelAutoStart` runs `resolveReplyModel` over the same
  option set the widget uses: the last used model if it is still there, else a
  connected cloud provider, else the only local model, else the lightest of
  several by the parameter count in its name. Anything found is selected and
  started on the spot; the typed message is queued exactly as after a widget
  choice and goes out when the model can answer, with "Starting *name*…" in
  the composer instead of a modal. The widget opens only when there is nothing
  to decide with: no model at all, or several local models whose names carry
  no size. A local model is still never started at launch — the line the
  preload decision drew stands; the send is the intent that pays for the load.
  A *cloud* selection now survives a launch with preload off: it holds no
  memory, so the setting's reason does not apply, and `DropdownModelProvider`
  drops it on mount if the provider has since been disconnected.
- **Consequences:** the modal disappears from the common path and remains
  for the empty-handed and the genuinely ambiguous. The silent path is
  measured on its own — `reply_model_auto_resolved` with the `resolution`
  taken, beside `reply_model_gate_shown`; the two together are every send that
  met an empty selection, and `reply_model_gate_ready` carries `resolution`
  so time-to-answer is comparable across both. A load that fails drops the
  queued send rather than leaving "starting…" on screen. The size-by-name
  rule is a heuristic and is allowed to abstain: two models named without a
  parameter count are offered, not guessed between. The dropdown's own
  startup restore is unchanged; only the persisted cloud selection is kept.
- **Owner:** `team`
- **Links:** `web-app/src/hooks/useReplyModelAutoStart.ts`,
  `web-app/src/lib/reply-model-gate.ts` (`resolveReplyModel`,
  `estimateParamsB`), `web-app/src/lib/reply-gate-telemetry.ts`,
  `web-app/src/containers/ChatInput.tsx`, `web-app/src/main.tsx`,
  `web-app/src/containers/DropdownModelProvider.tsx`,
  [ATO-461](https://linear.app/atomicchat/issue/ATO-461)
