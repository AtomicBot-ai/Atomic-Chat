---
date: 2026-09-17
title: "Keep onboarding download actions compact and stable"
---

# 2026-09-17 — Keep onboarding download actions compact and stable

- **Context:** Danny's onboarding review found vague memory labels, a redundant recommendation claim, size-dependent action widths, and a small ChatGPT mark.
- **Decision:** Show Runs well / May be slow / Too large with keyboard-accessible explanatory tooltips. Put download size after the memory badge and truncate the model title first. Show a real summary or Balanced speed and quality. Keep Download and disabled Downloading… in a fixed compact action slot; cancellation stays in the download panel. Route marks use the same 32 px footprint, and the cloud action says Add API Key.
- **Consequences:** The onboarding RouteRow variant action slot is 8.5rem with scalable text-xs labels; unusually long translations truncate within the reserved slot. Other RouteRow consumers keep their previous action and icon sizes. Shared memory badge labels change wherever ModelFitIndicator is used; onboarding supplies the new generic tooltips while retaining detailed memory reasons for confirmation dialogs. Chromium measures the production SetupModelRow and RouteRow at both supported font sizes and desktop widths in both themes.
- **Owner:** team.
- **Links:** [SetupScreen](../../web-app/src/containers/SetupScreen.tsx), [layout rules](../ui-layout-rules.md).

Supersedes: [2026-09-17-one-button-column-and-a-fit-badge-on-the-onboarding-rows.md](2026-09-17-one-button-column-and-a-fit-badge-on-the-onboarding-rows.md).
