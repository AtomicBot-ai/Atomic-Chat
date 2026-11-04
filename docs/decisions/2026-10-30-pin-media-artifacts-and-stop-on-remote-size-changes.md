---
date: 2026-10-30
title: "Pin media artifacts and stop on remote size changes"
---

# 2026-10-30 — Pin media artifacts and stop on remote size changes

- **Context:** AC-230-006 downloaded Z-Image through `resolve/main` while validating the previous file's size and SHA-256. The publisher replaced the file on 29 October. The segmented probe noticed the new size but fell back to a single stream; EOF and HTTP 416 then restarted the complete transfer. Removing hash validation would neither repair the size mismatch nor preserve integrity.
- **Decision:** Allow an optional immutable 40-character Hugging Face `revision` on each media checkpoint as well as on the transformer and side files (ADR `2026-10-30-pin-diffusion-catalog-downloads`, whose Z-Image data at `b40f712c` this keeps). Use a bundled revision for an older catalog only when repository, filename, exact size and hash all match. Explicit catalog revisions take precedence, and a checkpoint's revision over its transformer's. Keep size and SHA-256 validation.
- **Consequences:** Existing catalogs and caches of the pinned files can download them without a catalog update. New artifact metadata never inherits an older artifact's revision. An HTTP response reporting another size, or rejecting the saved offset with HTTP 416, fails without retrying or truncating the partial. Ordinary transient network retries and fallback for servers that ignore ranges remain supported. Moving from a mutable URL to a pinned URL starts a new partial identity, since old bytes may belong to the publisher's replacement. Other unpinned artifacts fail early on a known size mismatch and need consistent catalog metadata before retrying.
- **Owner:** team.
- **Links:** [Publisher update](https://huggingface.co/unsloth/Z-Image-Turbo-GGUF/commit/b40f712c569ecfff42f2307dcc43399ae1d71318), `src-tauri/src/core/downloads/helpers.rs`, `web-app/src/lib/diffusion/models.ts`, `atomic-chat-conf/models/diffusion.json`.
