---
date: 2026-10-27
title: "Configure the server's engine from its picker, with the Hub's settings"
---

# 2026-10-27 — Configure the server's engine from its picker, with the Hub's settings

- **Context:** Server → Engine & model picked an engine and a model, but the
  engine's own settings (context fit, threads, MTP / DFlash, the backend
  build) were only on Models Hub → Inference engines and the engine's page.
  The prototype adds a gear beside the chosen engine that opens them in a
  dialog with its own draft and Cancel / Save changes.
- **Decision:** The gear opens `ServerEngineConfigDialog`, which hosts the
  same `EngineDetail` the Hub unfolds (`embedded`), without the engine's
  on/off switch. Settings are saved as they change, as they are in the Hub,
  so the dialog closes with Done instead of keeping a draft of its own. The
  gear is in the engine field of `ServerDetailPicker` (`configure`), so the
  server setup guide's Engine & model step has it too.
- **Consequences:** One code path for engine settings: the toggles with side
  effects (MTP / DFlash / EAGLE-3 downloads, backend installs and switches)
  behave the same from both places. A change cannot be cancelled from the
  dialog; Reset settings puts the defaults back. Most settings apply the next
  time the engine loads a model, which the dialog says. Switching the engine
  off stays on the Hub, so the dialog never takes away the engine it opened
  on.
- **Owner:** `team`.
- **Links:** `web-app/src/containers/server/ServerEngineConfigDialog.tsx`,
  `web-app/src/containers/server/ServerPageParts.tsx`,
  `web-app/src/containers/engines/EngineDetail.tsx`,
  `2026-10-20-unfold-engine-settings-and-offer-engine-updates-on-the-overview.md`.
