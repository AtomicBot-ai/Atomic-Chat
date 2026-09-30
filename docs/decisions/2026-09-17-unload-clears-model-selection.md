---
date: 2026-09-17
title: 'Clear the composer selection after an explicit local model unload'
---

# 2026-09-17 — Clear the composer selection after an explicit local model unload

- **Context:** the composer unload action refreshed engine state but retained the
  selected model, leaving its old name beside an inactive circle. Settings Stop
  behaved the same way. Clearing selection alone also allowed the picker to
  restore the last-used model when remounted with preload enabled.
- **Decision:** a successful user unload clears the matching provider/model
  selection, without changing the provider catalog or downloaded files. Settings
  Stop confirms the selected model is absent from its own engine before clearing
  it, because bulk stop does not propagate returned unload failures. An empty
  composer with user-stop records stays empty on picker initialization; the user
  can select and start any retained model again.
- **Consequences:** the English trigger reads "Select Model" after unload.
  Selection changes during an asynchronous unload are preserved, including the
  same model id on another engine. Returned and thrown unload failures retain
  selection. Backend restarts, load cancellation, automatic memory arbitration,
  and failed-load recovery do not use selection clearing. Stop records remain
  session-only; this does not change startup preload preferences or last-used
  history. The same logic covers llama.cpp, upstream llama.cpp, MLX, and
  Foundation Models; cloud and diffusion selections are separate.
- **Owner:** `team`.
- **Links:** `web-app/src/utils/switchModel.ts`,
  `web-app/src/containers/DropdownModelProvider.tsx`,
  `web-app/src/containers/__tests__/DropdownModelProvider.unload.test.tsx`.

Supersedes the retained-selection behavior of
[the status-dot and Stop decision](2026-09-11-show-engine-state-in-the-model-dot-and-let-a-stop-hold.md).
