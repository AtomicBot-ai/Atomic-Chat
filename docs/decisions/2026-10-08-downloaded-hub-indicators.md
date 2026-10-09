---
date: 2026-10-08
title: "Mark downloaded models in Hub lists"
---

# 2026-10-08 — Mark downloaded models in Hub lists

- **Context:** ATO-265 asks to recognise downloaded models while browsing and searching, without enabling the Downloaded filter. Details already recognise installed quants, but catalog rows have no marker.
- **Decision:** Add a compact green check with the localized Downloaded accessible label to each installed repository row. Reuse the existing exact GGUF-quant, MLX-id and managed-repository matching rules against the reactive provider registry. Ignore missing files and internal embeddings; keep provider formats separate. Do not guess a GGUF repository from a similar filename before its quant metadata arrives.
- **Consequences:** Any installed quant marks the repository. Download/delete registry updates refresh the marker immediately; checks require no new storage. When local GGUF weights exist, visible search results use the existing two-request metadata cache to resolve exact quant ids before selection. Long names truncate before the marker and format badge. Feed rows become matchable when their existing background metadata lookup supplies quant ids.
- **Owner:** @plombeer31.
- **Links:** ATO-265; `web-app/src/lib/hub-installed.ts`; `web-app/src/containers/hub/ModelListRow.tsx`.
