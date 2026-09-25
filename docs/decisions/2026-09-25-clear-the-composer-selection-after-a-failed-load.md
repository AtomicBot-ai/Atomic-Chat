---
date: 2026-09-25
title: 'Clear the composer selection after a failed model load'
---

# 2026-09-25 — Clear the composer selection after a failed model load

- **Context:** when a model failed to load, the composer pill kept its name
  beside a red "Failed to load" dot. It looked like a model the user could
  still chat with. The decision that clears the selection after a user unload
  deliberately left failed loads out.
- **Decision:** a load that ends in an error clears the matching
  provider/model selection, so the pill reads "Select Model". This covers a
  pick, a Send and the composer's auto-start. A cancelled load keeps its
  selection, and so does a failure after a later switch was requested or after
  the selection moved on. While a load error is recorded, picker initialization
  does not put the last-used model back into the empty composer. A Retry or an
  edit in a conversation with nothing selected first selects that thread's own
  model again, because the chat transport answers with whatever is selected.
  A send held for the failed model is dropped when its selection goes away,
  not when the selected model carries an error.
- **Consequences:** the red failed dot is now rare in the pill. It stays only
  where a model is selected without a switch and matches the recorded error.
  The failure toast is unchanged and still carries the reason. Picking the model
  again retries the load explicitly. A Send with nothing selected still resolves
  the reply model from last-used history, which can be the model that failed.
  The error from the previous failure no longer drops that send. The load error
  is session-only, so a relaunch restores startup preload as before. Cloud
  providers whose registration fails lose their selection the same way. An
  agent-mode Retry with nothing selected still asks for a local model: the
  agent path reads the selection from the render before the Retry.
- **Owner:** `team`.
- **Links:** `web-app/src/utils/switchModel.ts`,
  `web-app/src/containers/DropdownModelProvider.tsx`,
  `web-app/src/containers/ChatInput.tsx`,
  `web-app/src/routes/threads/$threadId.tsx`,
  `web-app/src/containers/__tests__/DropdownModelProvider.unload.test.tsx`,
  `web-app/src/containers/__tests__/ChatInput.simple.test.tsx`.

Supersedes the failed-load exception in
[the unload-clears-selection decision](2026-09-17-unload-clears-model-selection.md).
