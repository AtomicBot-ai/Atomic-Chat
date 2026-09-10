---
date: 2026-08-14
title: "Show the streaming code while an HTML artifact generates"
---

# 2026-08-14 — Show the streaming code while an HTML artifact generates

- **Context:** `HtmlArtifact` already refuses to hand a half-written document to
  the preview iframe while `streaming` is set, but the flag never reached it in
  chat. `$threadId.tsx` reports `CHAT_STATUS.SUBMITTED` for the whole request
  (`inputStatus = requestActive ? SUBMITTED : status`), while `MessageItem`
  derived streaming from `status === STREAMING`. So `ArtifactTrigger` and
  `HtmlArtifact` saw `streaming === false` for the entire generation: the iframe
  was re-navigated on every token — on Tauri once per token, which is exactly the
  WKWebView race the guard exists to avoid — and the panel visibly flickered.
  The same dead flag meant the trigger never auto-opened the panel when the first
  generation settled. Opening the panel mid-generation showed a static progress
  placeholder, so there was no sign the model was still writing.
- **Decision:** derive the artifact's generating state from the active request
  (`isStreaming || isRequestActive`) rather than from `status === 'streaming'`.
  While generating, `HtmlArtifact` shows the Code pane with a notice and the
  progress percentage, follows the tail of the code as it streams in, and hands
  the viewer back to the Preview pane once the request settles.
- **Consequences:** the iframe now navigates once per settled document, so the
  flicker and the Tauri scheme-task race are both gone, and the auto-open on
  completion works again. Tail-following stops as soon as the reader scrolls more
  than 48px away from the bottom and resumes when they return; it is driven by a
  `ResizeObserver` because Shiki re-highlights asynchronously, with a direct
  scroll on `code` change as the fallback for environments without one. The
  artifact stays "generating" until the whole request finishes, so a message that
  keeps writing prose after `</html>` delays the preview — acceptable, and
  consistent with how the agent workspace already hides its preview column while
  a run is active. A reader who switches to Preview mid-generation keeps that
  choice and sees the existing placeholder.
- **Owner:** `team`
- **Links:** `web-app/src/containers/HtmlArtifact.tsx`,
  `web-app/src/containers/MessageItem.tsx`,
  `web-app/src/containers/ArtifactPanel.tsx`,
  `web-app/src/containers/__tests__/HtmlArtifact.test.tsx`,
  [Add a scoped three-column workspace to agent threads](2026-07-20-add-a-scoped-three-column-workspace-to-agent-threads.md)
