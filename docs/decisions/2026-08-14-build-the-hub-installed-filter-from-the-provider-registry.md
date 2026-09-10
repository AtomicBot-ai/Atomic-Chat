---
date: 2026-08-14
title: "Build the Hub \"Installed on this device\" list from the provider registry"
---

# 2026-08-14 — Build the Hub "Installed on this device" list from the provider registry

- **Context:** the Hub's "Installed on this device" checkbox filtered the curated
  catalog down to the entries whose quant id matched a model registered by
  `llamacpp` / `llamacpp-upstream` / `mlx`. Anything installed *outside* the
  catalog therefore could not appear at all: long-tail Hugging Face downloads,
  manually imported GGUF files, and everything found by the local scan (LM
  Studio, Ollama, HF cache, Unsloth). Since the catalog largely overlaps with the
  recommendation and staff-pick repos, the filter looked like it only listed
  recommended models. On top of that the list stayed subject to the format
  filter, whose default is GGUF, so installed MLX models were hidden as well.
- **Decision:** the list is now built from the provider registry — the source of
  truth for what is on disk — and only *enriched* from the catalog. A catalog
  entry that claims an installed id is rendered as before (keeping its quant
  list, README and stats); every remaining installed id gets a synthesized
  `CatalogModel` whose single quant is the installed id, which is what the
  download panel reads to offer "New chat" rather than a download. The matching
  and synthesis rules live in `web-app/src/lib/hub-installed.ts`. In this mode
  the format and fit filters are skipped: they describe what to look for in the
  catalog, and applied here they can only hide something the user already has.
  Search still works, as a substring match over the id and developer — the
  MiniSearch index knows nothing about synthesized entries.
- **Consequences:** the filter now answers "what is on this device" instead of
  "which catalog entries do I have", which is what its label promises. Rows for
  uncatalogued models carry no size, downloads or README, and their "Open on web"
  link points at a Hugging Face repo that may not exist (an Ollama or
  hand-imported id is not a repo id). The MLX base-Gemma-4 guard and the fit
  filter no longer apply here, so an installed model that those would suppress is
  listed — it is already selectable in the model dropdown, so hiding it in the
  Hub only confuses. Embedding models stay out: they are an internal retrieval
  download and cannot serve a chat.
- **Owner:** `team`
- **Links:** `web-app/src/lib/hub-installed.ts`,
  `web-app/src/lib/__tests__/hub-installed.test.ts`,
  `web-app/src/routes/hub/index.tsx`,
  `web-app/src/containers/hub/HubFilters.tsx`
