---
date: 2026-09-18
title: "Preserve gallery selection during image generation"
---

# 2026-09-18 — Preserve gallery selection during image generation

- **Context:** Running generation always replaced the central viewer with progress, and each completed batch selected its first output. Users could not inspect existing images without their selection being replaced.
- **Decision:** Keep a session-only `live` or `gallery` viewer mode in the gallery store. Starting or adopting a generation selects live mode once; pending tiles return to it. Explicit gallery selection and keyboard navigation select gallery mode. Prepending outputs preserves a valid deliberate selection; live mode follows new outputs when generation ends.
- **Consequences:** Selection survives workflow navigation and repeated batches, while Generate starts a fresh live preview. Generation and its cancellation remain independent of viewer selection. No persisted schema changes.
- **Owner:** team.
- **Links:** `web-app/src/stores/image-gallery-store.ts`, `web-app/src/stores/image-generation-store.ts`, `web-app/src/containers/images/ImageGenerationPage.tsx`.
