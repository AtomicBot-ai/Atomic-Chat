---
date: 2026-09-21
title: "Catalog Qwen-Image-2.1 for non-commercial use"
---

# 2026-09-21 — Catalog Qwen-Image-2.1 for non-commercial use

- **Context:** Qwen-Image-2.1 is a new architecture supported by stable-diffusion.cpp `master-883-137f740` and licensed only for non-commercial research/evaluation. Text-to-image needs the Q4_K transformer, Qwen-Image-2.1 VAE and Qwen3-VL text encoder; reference-conditioned editing additionally needs the Qwen3-VL vision projector.
- **Decision:** Add one verified `qwen-image-2.1` catalog family with Create, Reference and Edit capabilities, an explicit non-commercial warning and the exact official Hugging Face sizes and hashes. Treat `llm_vision` as an optional companion for Create and a required companion for Reference/Edit. Keep schema version 1 because the vocabulary additions are backward-compatible: older clients safely drop the unknown family. Use the official 2048×2048 / 40-step default, bounded by Atomic Chat's current 2048-pixel UI/runtime ceiling and a 32-pixel dimension multiple.
- **Consequences:** Create downloads 9,900,789,304 bytes; Reference/Edit require the 1,159,029,824-byte projector too, for 11,059,819,128 bytes total. The family must not be offered by builds older than `master-883-137f740`, and commercial distribution remains blocked without a separate Qwen license. No unverified “uncensored” derivative is listed.
- **Owner:** team
- **Links:** [Qwen model card](https://huggingface.co/Qwen/Qwen-Image-2.1), [Qwen Research License](https://huggingface.co/Qwen/Qwen-Image-2.1/blob/main/LICENSE), [stable-diffusion.cpp guide](https://github.com/leejet/stable-diffusion.cpp/blob/master/docs/qwen_image_2.1.md), [GGUF transformer](https://huggingface.co/leejet/Qwen-Image-2.1-GGUF), [VAE](https://huggingface.co/Comfy-Org/Qwen-Image-2.1), [Qwen3-VL encoder and projector](https://huggingface.co/Qwen/Qwen3-VL-8B-Instruct-GGUF)
