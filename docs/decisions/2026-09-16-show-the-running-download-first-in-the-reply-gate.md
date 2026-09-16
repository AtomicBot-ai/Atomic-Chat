---
date: 2026-09-16
title: "Show the running download first in the reply gate, arm the message on it, and share the panel's Cancel"
---

# 2026-09-16 — Show the running download first in the reply gate, arm the message on it, and share the panel's Cancel

- **Context:** A user starts a model download (onboarding, the Hub, anywhere),
  has no model yet, types in the composer and presses Send. The blocked-send
  widget (`ReplyModelGate`, "Pick a model to start chatting") listed the
  manifest's recommendations and the cloud routes and said nothing about the
  transfer already running, unless the recommendation happened to be the same
  file — then it showed a disabled "Downloading… N%" row with no way to stop
  it. The widget promises "your message is saved … and it will be sent", but
  a download it did not start never sent anything: the composer arms its
  queued send only on an outcome the widget reports.
- **Decision:** A chat-model download under way is the first row of the
  widget's list, in the same `RouteRow` shape as the recommendations: mark,
  pretty name, and the download panel's readout on one line (`10% · 0.16 /
  1.58 GB · 1m 00s left`, `Paused · …`, or the pre-byte stage), with a
  secondary **Cancel** button. The status word comes from the panel's own
  formatter, moved into `lib/downloadFormat.ts` as `downloadStatusLabel`, so
  the two surfaces cannot read differently. Cancel calls the panel's
  branching, lifted into `lib/downloadCancellation.ts` as `cancelDownload`
  (download extension for `llamacpp*` / `mlx*` ids, model-service abort for
  everything else); the row disappears when the downloader confirms the stop
  and the store drops the entry, as the panel's row does. A recommendation for
  the same file is not listed a second time, and no other row is promoted to
  "best fit" while the lead is the one downloading. Only downloads that could
  answer the widget's question are listed: the embedding model, projector-only
  files, diffusion checkpoints, backend binaries and the voice model (a silent
  import that never becomes the selected model) stay in the panel only. On
  open with such a download present, the widget resolves itself with the new
  outcome `download_in_flight` — the way `auto_start` resolves on a model
  already on disk — so the composer arms the queued send and the message goes
  out when the download lands and `DataProvider` switches to it. A paused
  download reads "Paused" and keeps Cancel; Resume stays in the panel.
- **Consequences:** The widget now answers with what the app is already
  doing, and the message it saved is sent when that download finishes,
  without a click. The telemetry funnel gains an outcome value
  (`reply_model_gate_outcome.outcome = download_in_flight`, `decided_in_ms`
  ≈ 0, like `auto_start`), and `reply_model_gate_ready` reports it when the
  model comes up. Closing the widget after it armed itself is not a dismissal,
  same as after a Download click. Cancelling the only running download leaves
  the queued send armed with nothing on its way; it fires when the user next
  makes a model answerable, which is the composer's existing rule for a cancel
  from the panel too, and an emptied field sends nothing. If the finished
  model fails to load, the composer drops the send and the widget stays open
  on its recommendations, which do not know the file is now on disk. The
  `replyGate.downloading` / `downloadingPercent` strings are gone from every
  locale that carried them.
- **Owner:** @danyurkin.
- **Links:** follows
  [2026-09-15 Ask for a model with the same rows and the same list as onboarding](2026-09-15-ask-for-a-model-with-the-same-rows-and-list-as-onboarding.md);
  [`web-app/src/containers/ReplyModelGate.tsx`](../../web-app/src/containers/ReplyModelGate.tsx),
  [`web-app/src/lib/downloadCancellation.ts`](../../web-app/src/lib/downloadCancellation.ts),
  [`web-app/src/lib/downloadFormat.ts`](../../web-app/src/lib/downloadFormat.ts),
  [`web-app/src/containers/DownloadManegement.tsx`](../../web-app/src/containers/DownloadManegement.tsx).
