---
date: 2026-10-09
title: "Run Qwen-Image-2.1-Turbo as a Qwen-Image-2.1 sibling"
---

# 2026-10-09 — Run Qwen-Image-2.1-Turbo as a Qwen-Image-2.1 sibling

- **Context:** Qwen released Qwen-Image-2.1-Turbo on 2026-10-09, an accelerated checkpoint of the same 7B architecture with the same Qwen3-VL text encoder, vision projector and VAE. It generates and edits in 8 steps at CFG 1 on a fixed sigma schedule, under the same non-commercial Qwen Research License. The catalog registry drops a family id the client does not know, so a remote entry alone reaches nobody.
- **Decision:** Add the `qwen-image-2.1-turbo` family id and give it everything `qwen-image-2.1` has in the client: Create, Reference and Edit, the `master-883-137f740` engine gate with the stale-manifest fallback, the 1024px load-time default and the Qwen logo. Its catalog entry carries the official 8-value schedule as `defaults.sigmas`, one value per step (the registry keeps refusing a 0); core ≥ 0.11.7 sends it as `custom_sigmas` with the closing 0 sd.cpp needs, in the image body as in the video one (core ADR `2026-10-09-a-distilled-schedule-closes-on-zero-and-qwen-image-2-1-turbo-joins-its-family`).
- **Consequences:** Clients from this release on list Turbo once conf carries the entry; older clients drop it. A step count other than 8 runs sd.cpp's own schedule, as with LTX-2. The conf entry waits for the Atomic-converted GGUF; its sizes and hashes follow the 2026-09-21 catalog rules. The licence warning of Qwen-Image-2.1 applies unchanged.
- **Owner:** team
- **Links:** [Qwen-Image-2.1-Turbo model card](https://huggingface.co/Qwen/Qwen-Image-2.1-Turbo), [Catalog Qwen-Image-2.1 for non-commercial use](2026-09-21-catalog-qwen-image-2-1-for-non-commercial-use.md), [Gate Qwen-Image-2.1 on the installed engine](2026-09-21-gate-qwen-image-2-1-on-installed-engine.md)
