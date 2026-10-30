---
date: 2026-10-30
title: "Pin diffusion downloads to each repository's commit"
---

# 2026-10-30 — Pin diffusion downloads to each repository's commit

- **Context:** Unsloth replaced Z-Image Turbo quantizations on `main`. The Q4_K_M file changed from 5,017,613,376 to 3,850,130,496 bytes, while conf retained the old size and hash. Integrity checks correctly refused the new file. Neither client consumed diffusion revisions.
- **Decision:** Add optional full-commit `transformer.revision` and side-file `revision` fields to diffusion schema version 1. Resolve each entry against its own repository's commit; never inherit a transformer pin into VAE or text-encoder repositories. Keep legacy `main` only when a pin is absent, and reject malformed explicit pins. Update Z-Image Turbo sizes and hashes to Unsloth commit `b40f712c569ecfff42f2307dcc43399ae1d71318`.
- **Consequences:** New clients keep downloading the same bytes if upstream moves `main`; existing catalogs remain readable. Old clients ignore the new field and need a release for pinning to take effect. Size and SHA-256 verification remain mandatory. Metadata was checked against the Hub; image generation with the replacement quants was not validated. No change to core or the download protocol.
- **Alternatives:** Keeping the old files needs the same client support and delays the metadata-only repair for released clients. Updating metadata without a pin repeats the failure on the next replacement. Disabling integrity verification is unacceptable.
- **Owner:** team.
- **Links:** [Server issue #41](https://github.com/AtomicBot-ai/atomic-server/issues/41), [Unsloth replacement](https://huggingface.co/unsloth/Z-Image-Turbo-GGUF/commit/b40f712c569ecfff42f2307dcc43399ae1d71318), `../atomic-chat-conf/models/schema.diffusion.json`.
