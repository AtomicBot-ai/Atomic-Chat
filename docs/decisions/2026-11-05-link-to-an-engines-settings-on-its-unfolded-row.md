---
date: 2026-11-05
title: "Link to an engine's settings on its unfolded row"
---

# 2026-11-05 — Link to an engine's settings on its unfolded row

- **Context:** Models Hub → Inference engines unfolds each engine's settings
  in place ([2026-10-20](2026-10-20-unfold-engine-settings-and-offer-engine-updates-on-the-overview.md)),
  but every link to an engine's settings still opened the engine's own page
  (`/settings/providers/$providerName`), the pre-redesign screen: the chat
  model picker's gear, a managed engine's "Logs" and context-overflow card,
  the Hub's engine install and blocker buttons, the update banner's
  reinstall, and the page shown after an engine is deleted. QA 2.3.5 reported
  the gear landing on that old screen.
- **Decision:** Those links open the overview with that engine's row unfolded
  and scrolled to: `engineSettingsLink(engine)` →
  `/settings/providers?openEngine=<id>`. A reinstall adds `engineUpdate`, so
  the row's managed setup asks to confirm it, as the engine's page did. The
  row unfolds again each time a link names it, even after it was folded.
  Deleting an engine returns to the overview. A cloud provider's gear keeps
  the old route, which forwards to `/cloud`.
- **Consequences:** The engine's page now serves only what the row does not
  show: its models list and the Embedding / Decision model sections. The
  links into those stay: the Hub's Embedding and Decision "Open" and the
  row's "Models and all settings". Moving them needs a new home for those
  models first. The search key is `openEngine`, not `engine`, because the
  Hub's search already types `engine` as a model format and the route
  search types merge.
- **Owner:** `team`.
- **Links:** `web-app/src/lib/engine-settings-link.ts`,
  `web-app/src/routes/settings/providers/index.tsx`,
  `web-app/src/containers/engines/InferenceEnginesOverview.tsx`,
  `web-app/src/containers/DropdownModelProvider.tsx`,
  `web-app/src/hooks/useEngineUpdate.ts`.

<!--
Supersedes: 2026-10-20-unfold-engine-settings-and-offer-engine-updates-on-the-overview.md (a reinstall offer no longer opens the engine's page)
-->
