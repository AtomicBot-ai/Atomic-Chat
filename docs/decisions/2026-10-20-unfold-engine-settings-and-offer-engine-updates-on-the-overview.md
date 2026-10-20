---
date: 2026-10-20
title: 'Unfold engine settings and offer engine updates on the overview'
---

# 2026-10-20 — Unfold engine settings and offer engine updates on the overview

- **Context:** [The grouped overview](2026-10-20-list-inference-engines-on-one-grouped-overview.md)
  showed a Running / Idle / Disabled status and an enable switch per
  language engine, and its card opened the engine's page; its settings were
  not ported because the prototype's inline form bypassed
  `providers().updateSettings`. The approved prototype was updated the same
  day (e4a14d1): a row now says whether the engine's build is current
  ("Update available" / "Up to date"), carries "Update" while one is offered,
  and its settings unfold under it. The user also asked for a "Check for
  updates" button and, on Windows and Linux, "Find optimal backend".
- **Decision:** Every row on Models Hub → Inference engines is a header and a
  panel that unfolds underneath:
  - The header names the engine with its model count, build and "Disabled"
    when it is off; the status is the core's update answer
    (`useEngineVersionsStore`): Updating…, Update available, Up to date or Not
    installed, nothing before the core answered. "Update" installs the offer
    through the core as the banner does (`installEngineUpdate`, shared with
    `useEngineUpdate`); a `reinstall` offer opens the engine's page to be
    confirmed there.
  - A language engine's panel is its page's settings form:
    `/settings/providers/$providerName` moved into
    `containers/engines/EngineDetail.tsx`, and `embedded` renders the enable
    switch, the managed / Prism / Foundry panels and the settings card with
    their real handlers, without the models, which stay on the page (a link
    at the panel's end opens it). Media and Voice keep their panels.
  - The page header has "Check for updates": a forced
    `refresh({ force: true })` of every engine, then a toast with what it
    found. On Windows and Linux the two llama.cpp rows carry "Find optimal
    backend", the same flow as on the engine's page (`useFindOptimalBackend`).
- **Consequences:**
  - Supersedes the 2026-10-20 overview's status (Running / Idle) and its
    card-wide link; the enable switch moves into the unfolded panel.
  - An open panel mounts the engine page's component, so its effects (provider
    refresh after a hot-swap, the backend updater) run while it is open, as on
    the page. Two open panels are two instances, one per engine.
  - Voice shows stock llama.cpp's build status; its update is offered on that
    engine's row only.
- **Owner:** team
- **Links:** `web-app/src/containers/engines/InferenceEnginesOverview.tsx`,
  `web-app/src/containers/engines/EngineDetail.tsx`,
  `web-app/src/hooks/useFindOptimalBackend.ts`,
  `web-app/src/hooks/useEngineUpdate.ts`

<!--
Supersedes: 2026-10-20-list-inference-engines-on-one-grouped-overview.md (status, card link and switch only)
-->
