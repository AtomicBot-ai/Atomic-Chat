---
date: 2026-10-20
title: 'Turn the served models off with the server'
---

# 2026-10-20 — Turn the served models off with the server

- **Context:** A model brings the Local API Server up with it: a chat model
  through `switchModel.ts`, an image, video, embedding or decision model
  through `raiseLocalApiServerForMediaModel`. The reverse did not hold: Stop
  in the Server sidebar or the tray only stopped the proxy, so models stayed
  loaded with nothing serving them. The sidebar also had a Restart button and
  the Server pages an "Apply & restart", which the updated prototype removed
  (e4a14d1). The Engine & model page chose only the chat model, though the
  server also serves an embedding model (`/v1/embeddings`) and a decision
  model (`/v1/systemone`, `/v1/router/score`). Its native `<select>`s opened
  the macOS popup over the field instead of under it.
- **Decision:** Turning the server off goes through one function,
  `turnOffLocalApiServer`: the control hook's `stop()` (sidebar Stop, the
  Server pages) and the tray's Stop both use it. It stops the server, then
  unloads the local chat models as a user stop, an image or video model, and
  switches the embedding and decision models off, remembering those two
  (`pausedHelperModels`) so the next start switches them back on
  (`resumeServedHelperModels`). A restart passes `stop({ keepModels: true })`
  and keeps everything loaded. The sidebar has no Restart; saving on a Server
  page reads "Save changes" and applies the change. Engine & model gets
  "Embedding model" and "Decision model" dropdowns (None or a downloaded
  model), applied on Save as their Start in the Hub does. The Server pages'
  dropdowns are `ServerSelect`, which always drops under the field.
- **Consequences:**
  - Stopping the server ends in-app chat with a local model too; the next
    message loads it again (and the server with it, when auto-start is on).
  - A failed unload is logged and never keeps the server up; a failed stop
    leaves the models as they were.
  - A choice made on Engine & model clears that kind from the paused list, so
    the next start does not bring the previous model back.
- **Owner:** team
- **Links:** `web-app/src/utils/turnOffLocalApiServer.ts`,
  `web-app/src/hooks/useLocalApiServerControl.ts`,
  `web-app/src/hooks/useTrayStatusSync.ts`,
  `web-app/src/containers/server/ServerModelPicker.tsx`,
  `web-app/src/containers/server/useServedHelperModels.ts`,
  `web-app/src/containers/server/ServerPageParts.tsx` (`ServerSelect`),
  [Raise the server for a resident image or video model](2026-09-25-raise-the-local-api-server-for-a-resident-image-or-video-model.md)
