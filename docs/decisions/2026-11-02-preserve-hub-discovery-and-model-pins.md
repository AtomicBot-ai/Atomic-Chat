---
date: 2026-11-02
title: 'Preserve generated Hub discovery alongside managed model pins'
---

# 2026-11-02 — Preserve generated Hub discovery alongside managed model pins

- **Context:** The unified managed catalog contains selected recommendations and auxiliary models. Using its chat subset as the Hub's entire discovery list would remove thousands of searchable models, bypass the prebuilt MiniSearch index and ignore the large bundled offline snapshot. Passing tests for downloads did not establish preservation of search coverage.
- **Decision:** Keep `atomic-chat-model-catalog` as the generated discovery feed with the existing URL overrides, ranking, cache and bundled catalog/index. Keep `atomic-chat-conf/models/catalog.json` as the single editable catalog for managed sources and recommendations. These responsibilities do not require a second manually maintained model definition file.
- **Version selection:** A managed recommendation carries its explicit revision through sanitization and card resolution. It is resolved from that revision's metadata independently of a discovery card for the same repository. Discovery and exact HF search use their selected commit, or resolve a legacy moving reference once during preparation. A repository-name match in the managed catalog must never silently replace a discovery revision. MLX preparation receives the selected card's commit and rejects a substituted response.
- **Discovery producer:** The scraper records the full SHA from the HF metadata response and uses it for every shard, projector and safetensors URL. `revision` is additive; envelope versions and external IDs remain stable. Existing generated snapshots and their caches remain readable while the producer rolls out. Malformed or missing SHA cannot generate a new floating entry.
- **Downloads:** Both sources use the same versioned immutable download-plan mechanism. Updating either catalog cannot change Resume or automatically replace an installed model. Existing paths, runtime descriptors and mobile behavior retain their contracts.
- **Validation:** Targeted regressions cover the default wide discovery path, index retention, bundled offline coverage, independent versions for one repository, managed revision sanitization and immutable MLX preparation. The discovery producer has offline tests against both newly pinned entries and the existing published catalog. Full application verification remains required before release; the repository currently has no automatic full PR gate. The operator explicitly requested targeted local tests only for this correction, so an earlier full run must not be presented as validation of this revision.
- **Owner:** team.
- **Links:** [Desktop PR #399](https://github.com/AtomicBot-ai/Atomic-Chat/pull/399), [discovery producer](https://github.com/AtomicBot-ai/atomic-chat-model-catalog), [managed catalog decision](2026-11-01-unify-model-catalog-and-download-plans.md).
