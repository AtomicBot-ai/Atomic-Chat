---
date: 2026-11-09
title: "Offer FastFlowLM in the Model Hub, outside onboarding"
---

# 2026-11-09 — Offer FastFlowLM in the Model Hub, outside onboarding

Supersedes the FLM onboarding offers and automatic onboarding engine installation clauses of [model-first onboarding](2026-11-09-keep-onboarding-model-first.md).

- **Context:** The operator requested no FLM model list in onboarding and reported that Model Hub's Filters menu omitted FLM. The Hub page already loaded FLM rows and admitted the format, but its Filters component calculated available formats without the core-registered FLM visibility flag.
- **Decision:** Keep onboarding's original ordinary model offers and library providers. Do not load the FLM catalog, offer installed FLM models, or run FLM preparation/download logic from that step. Ignore saved FLM model selections from previous QA builds so they cannot block the restored onboarding. Retain FLM model installation, engine settings and transfer recovery through their existing Hub/settings/download surfaces.
- **Hub visibility:** Pass the same core-registration visibility into both the Hub route and its Filters menu. Offer FastFlowLM as an engine and format before engine installation; choosing the engine selects the matching format. Registration remains the authority, without an independent frontend hardware probe or an installed-build gate.
- **Alternatives:** Hiding the FLM shelf with CSS would retain its catalog reads and inaccessible onboarding choices. Hiding the Hub option until the engine is installed would prevent users from discovering and setting it up. A separate menu availability policy would let the route and its controls drift again.
- **Validation:** Focused tests cover ordinary onboarding choices, previous QA FLM selections, absence of FLM catalog reads/library offers, pre-install Hub visibility and coupled engine/format selection. Chromium measures the ordinary onboarding screen and the expanded Hub menu at supported font sizes. No aggregate verification or commit is authorized by this change.
- **Owner:** team.
- **Links:** [Hub filters](../../web-app/src/containers/hub/HubFilters.tsx), [onboarding offers](../../web-app/src/containers/onboarding/useModelOptions.ts), [onboarding UI](../../web-app/src/containers/onboarding/steps/ModelStep.tsx).
