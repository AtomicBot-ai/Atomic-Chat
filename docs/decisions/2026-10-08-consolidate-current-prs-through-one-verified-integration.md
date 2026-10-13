---
date: 2026-10-08
title: 'Consolidate current PRs through one verified integration'
---

# 2026-10-08 — Consolidate current PRs through one verified integration

- **Context:** Current PRs overlap in HTML sanitization, backend error classification, model selection, dependencies and CI. Historical backup/test snapshots are intentionally outside the user-approved consolidation.
- **Decision:** Preserve the current PR ancestry in one integration branch, resolve overlaps once, and validate the combined tree before merging it into main. Keep DOMPurify in the consuming web workspace and apply sanitization once. Retain Vitest 3 because the existing configuration and coverage packages have not migrated to Vitest 5; integrate the other dependency updates. Route optional Rust verification through the established repository workflow and use its native test feature/resource setup for Clippy.
- **Consequences:** The privacy parser and Windows unused import are repaired. Media adapter descriptors, registry validation, factory selection and settings agree, and failed Replicate cancellation must remain an error. PR drafting files and lint-rewrite scratch scripts are excluded from the application. Historical snapshots and old rejected features remain preserved without reintroduction.
- **Owner:** @walladanger.
- **Links:** Current PRs #86, #87, #89, #90, #91, #92, #97, #98, #101, #110 and #111; `.github/workflows/radium-ci.yml`; `web-app/src/services/media/providerFactory.ts`.
