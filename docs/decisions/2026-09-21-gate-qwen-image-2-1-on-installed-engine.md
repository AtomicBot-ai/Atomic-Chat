---
date: 2026-09-21
title: "Gate Qwen-Image-2.1 on the installed engine"
---

# 2026-09-21 — Gate Qwen-Image-2.1 on the installed engine

- **Context:** QA-r5 loaded the correct, checksum-verified Qwen-Image-2.1 files with the existing profile's `master-849-d04e895` server. The bundled `master-883-137f740` manifest did not replace installed binaries. The old loader failed architecture detection before generation.
- **Decision:** Enforce Qwen 2.1's minimum build (883) at native install selection and every process spawn, rejecting unknown/older tags with `ENGINE_UPDATE_REQUIRED`. Keep existing backend/platform selection. Preflight in the web store offers the existing engine-update flow and retries the requested artifact after success. For this family only, stale remote/cached manifests fall back to the compatible bundled manifest, including its archive URLs and checksums.
- **Consequences:** Old profiles need an engine update but retain their downloaded models. Installation invalidates resident and retained specs under the load lock; waiting jobs re-read the spec after taking the lock so they cannot resurrect an old server. Other families retain their original engine policy. Future incompatible tag schemes require an explicit compatibility-policy update. Local DEBUG launch logs include the actual engine tag, backend, binary and argv for diagnosis.
- **Owner:** team
- **Links:** [QA evidence and validation](../../autoqa/qa-r5-qwen-engine-diagnosis.md), [Qwen catalog decision](2026-09-21-catalog-qwen-image-2-1-for-non-commercial-use.md).
