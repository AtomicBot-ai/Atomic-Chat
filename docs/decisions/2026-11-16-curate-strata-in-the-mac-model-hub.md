---
date: 2026-11-16
title: "Curate Strata in the Mac Model Hub"
---

# 2026-11-16 — Curate Strata in the Mac Model Hub

- **Context:** The Strata collection is shared across platforms. Its presence in the Hub did not tell a Mac user whether a model had a Metal build or whether there was room on the model volume.
- **Decision:** Use the catalog's `macos-arm64-metal` variant to select Strata rows on Apple Silicon. Add the exact Qwen3.8 IQ3_XXS variant verified in the desktop chat flow to the default Mac Recommended section. Show a disk-space refusal on the Strata catalog row and refresh it when the window regains focus.
- **Consequences:** A supported DeepSeek variant remains discoverable even when the disk is full. The core accounts for preparation once a compatible bundle is active. Until then the native volume query can establish that a fresh download's source files alone exceed free space. The card retains the full acquisition check.
- **Owner:** `team`.
