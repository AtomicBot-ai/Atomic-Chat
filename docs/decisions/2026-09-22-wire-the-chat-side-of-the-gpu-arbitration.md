---
date: 2026-09-22
title: "Wire the chat side of the GPU arbitration at the model-load chokepoint"
---

# 2026-09-22 — Wire the chat side of the GPU arbitration at the model-load chokepoint

- **Context:** The 2026-09-10 record put GPU arbitration in
  `web-app/src/lib/diffusion/arbiter.ts` with two directions: `acquireGpuForDiffusion`
  before an image model loads, and `releaseGpuForChat` "at the chat model-load
  chokepoint, `services/models/default.ts::startModel`". The first was called
  from the image store; the second was defined, documented and unit-tested, and
  called from nowhere — `startModel` went straight to `engine.load`. A chat
  model loading beside a resident image model competed with it for the GPU and
  failed or swapped instead of evicting it. Found while writing the desktop e2e
  scenario for the hand-off (`tests/e2e/desktop/image-chat-handoff.spec.ts`).
- **Decision:** `startModel` calls `makeRoomForChatModel(engine, modelId)`
  (`services/models/gpuRoom.ts`) just before `engine.load`. It asks the engine
  for the model's size (`engine.get(modelId).sizeBytes`, read from the model
  file whether or not it is loaded), passes it to `releaseGpuForChat`, and
  claims an infinite size when the engine does not know one — the arbiter's
  own rule that an unknown size does not fit. It is a no-op on platforms
  without image generation and never fails the load: an arbiter that cannot
  answer is logged and the load goes ahead.
- **Consequences:** With an image model resident, a chat model that would not
  fit beside it now unloads the image model first, as the record intended; one
  that fits leaves it. The image page shows the model as stopped afterwards and
  Run brings it back. The helper is the unit under test
  (`services/models/__tests__/gpuRoom.test.ts`); `startModel` gained one line.
- **Owner:** `team`.
- **Links:**
  - `web-app/src/services/models/{gpuRoom,default}.ts`
  - `2026-09-10-arbitrate-the-gpu-between-chat-and-diffusion-in-the-web-app.md`
