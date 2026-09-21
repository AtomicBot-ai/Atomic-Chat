---
date: 2026-09-17
title: "Widen the model selector and distinguish supported download formats"
---

# 2026-09-17 — Widen the model selector and distinguish supported download formats

- **Context:** The populated selector was 280 px wide, search removed MLX, and
  the Hugging Face service forced GGUF queries. Repository-only row keys and
  download state could conflate two formats. Provider settings icons also had
  a permanent resting fill and no reserved gap from the selected-provider dot.
- **Decision:** Use a 42 rem selector capped by the viewport, fixed model-list
  heights and internal scrolling. Search GGUF on every platform and additionally
  MLX on macOS, interleaving up to six candidates of each format. Label every
  search row and its accessible download action with GGUF or MLX; key rows and
  their download state by repository plus format. Keep the service's default
  GGUF behavior for other callers. Route MLX weights through the existing MLX
  engine import contract and exclude GGUF weights from its companion files.
  Make each provider's settings control a keyboard-accessible button with a
  12 px minimum separation and a background only on hover or visible focus.
- **Consequences:** Names have more space, downloads remain distinguishable,
  and search results cannot resize the shell. macOS makes two debounced list
  requests; details are still fetched only on click. A missing MLX engine is
  reported on download. Native WebKit and real download checks remain useful
  after integration; regression coverage measures Chromium with the app CSS.
- **Owner:** team.
- **Links:** [Original selector download decision](2026-09-16-model-selector-download-picks.md),
  [DropdownModelProvider](../../web-app/src/containers/DropdownModelProvider.tsx),
  [ModelPickerDownloads](../../web-app/src/containers/ModelPickerDownloads.tsx).

<!-- Supersedes the GGUF-only search decision in 2026-09-16-model-selector-download-picks.md. -->
