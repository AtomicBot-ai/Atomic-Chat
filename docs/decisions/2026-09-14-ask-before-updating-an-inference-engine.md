---
date: 2026-09-14
title: "Ask before updating an inference engine"
---

# 2026-09-14 — Ask before updating an inference engine

- **Context:** Both llama.cpp extensions ran `reconcileBackendReleaseTag()` at
  the end of `onLoad()`. When the release stream had moved on, it called
  `downloadRecommendedBackend()` straight away: a several-hundred-megabyte
  transfer on a launch the user asked nothing of, followed by a hot-swap that
  unloads whatever model was running. Nothing on screen said it was happening
  except the progress banner `<BackendUpdater />` shows once the transfer is
  already under way. ATO-528 / ATO-531 asked for a banner that *offers* the new
  build — "Show what's new / Remind me later / Update" — which cannot exist
  while the engine has already taken it.

- **Decision:** A release-tag bump is published as an offer instead of being
  applied. `reconcileBackendReleaseTag()` now calls `offerEngineUpdate()`, which
  writes `atomic_engine_update_offer_<provider>` and dispatches
  `app:engine-update-available` on the window; the web app's
  `<EngineUpdateBanner />` turns that into the bottom-right banner and only the
  user's "Update" calls `downloadRecommendedBackend()` — the exact call the
  reconciliation used to make. Recovery paths keep acting on their own: a
  `version_backend` parked on a `latest/<variant>` sentinel, and TurboQuant's
  first-run adoption, are a broken or incomplete configuration rather than an
  update. "Remind me later" hides the offer for 24 h; the × hides that specific
  target for good and a newer tag still gets a fresh hearing.

- **Consequences:** Users stop paying for engine updates they did not ask for,
  in bandwidth and in an unloaded model mid-session — but an engine now stays
  behind until somebody says yes, so a fix published upstream reaches users more
  slowly than it did. The banner quotes the archive size from the release index
  (the signed mirror's manifest upstream, `index.json` for TurboQuant) and says
  no restart is needed, which is true for llama.cpp because activation goes
  through `applyBackendLive()`; `restartRequired` travels in the payload so an
  engine that cannot hot-swap can say otherwise without a UI change. MLX
  publishes no offer: its sidecar ships inside the app bundle and has no
  independent release stream to compare against, so it updates with the app.
  Nothing in the hook or the banner is llama.cpp-specific — an engine that
  grows a release stream only has to publish an offer. The contract is
  duplicated between `web-app/src/lib/engineUpdateOffer.ts` and each extension's
  `src/engineUpdateOffer.ts`, the same way `app:backend-hotswapped` is, because
  an extension bundles its own copy of `@janhq/core` and cannot import from the
  web app; the three files have to move together.

- **Owner:** @m-skvortsov

- **Links:** [ATO-528](https://linear.app/atomicchat/issue/ATO-528),
  [ATO-531](https://linear.app/atomicchat/issue/ATO-531),
  [ATO-533](https://linear.app/atomicchat/issue/ATO-533),
  `extensions/llamacpp-extension/src/index.ts`,
  `extensions/llamacpp-upstream-extension/src/index.ts`,
  `web-app/src/hooks/useEngineUpdate.ts`,
  `web-app/src/containers/dialogs/EngineUpdateBanner.tsx`
