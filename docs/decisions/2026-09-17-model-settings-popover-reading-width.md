---
date: 2026-09-17
title: 'Give the composer model settings a bounded reading width'
---

# 2026-09-17 — Give the composer model settings a bounded reading width

- **Context:** The composer model chip's main popover used a fixed 280 px width and truncated the engine status. At Large and Extra Large, the first-message explanation disappeared behind an ellipsis and the effort scale felt squeezed.
- **Decision:** Give only the main settings view a 28 rem (448 px) width, bounded by a 16 px viewport gutter and Radix's available height. Use one 16 px content inset, a shrinking title column with a full-name tooltip, wrapping status copy, and the effort slider spanning the content width.
- **Consequences:** The explanation remains readable, including at Extra Large; narrow windows wrap it and short windows scroll inside the panel. The model list retains its existing geometry. No model selection, reasoning, status, or active-model indicator behavior changes.
- **Owner:** team.
- **Links:** `web-app/src/containers/DropdownModelProvider.tsx`, `web-app/src/containers/InferenceServerStatus.tsx`, `web-app/src/containers/DropdownModelProvider.layout.test.tsx`.
