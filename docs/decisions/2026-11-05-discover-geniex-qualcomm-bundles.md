---
date: 2026-11-05
title: "Discover GenieX bundles in Qualcomm releases"
---

# Discover GenieX bundles in Qualcomm releases

The GenieX shelf previously depended on Atomic adding each Qualcomm archive to its catalog. Search now reads the current public AI Hub Models release, filters text generation models, and checks the runtime and chipset on each published asset. The manifest's separate runtime and chipset lists alone cannot establish compatibility.

Qualcomm also lists portable GenieX llama.cpp assets. Resolve the exact GGUF path in its Hugging Face revision and use the repository commit and LFS SHA-256 for the model and projector.

Each external ZIP transfer pins the S3 object version and requires its size and full-object CRC-64/NVME. HTTPS and the fixed publisher origin establish provenance. The checksum detects corruption across resumed transfers. The core inspects the unpacked model before registration. Existing curated downloads keep their SHA-256 pins.

Owner: team. See [Qualcomm AI Hub Models CLI](https://github.com/qualcomm/ai-hub-models/tree/main/cli).
