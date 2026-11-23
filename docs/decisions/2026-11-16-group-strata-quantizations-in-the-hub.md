---
date: 2026-11-16
title: Group Strata quantizations in the Hub
---

# Group Strata quantizations in the Hub

The Qwen3.8 card groups the pinned quantizations compatible with the host's Strata build. It keeps the existing IQ3_XXS row ID and recommendation. Each choice has its own descriptor, disk check, download, preparation, and installed model ID. The underlying catalog entries stay independent so existing links, resumable transfers, and model registrations can keep their identifiers.

CUDA shows quantizations under their model release, with separate Flash-Next cards for the ISTA original, Swift, Coder, Unsloth, Gyro and NVFP4. Qwen3.6 and DeepSeek each group their compatible alternatives. The active build filters the underlying descriptors before grouping, so a CUDA 12 card cannot offer a DeepSeek download from this release.

The model row exposes the quant selector before it is expanded. The row keeps one selection per model group, so its download size and the expanded install action refer to the same variant. Registered local weights can be present during onboarding; their chat action becomes available after the Strata engine is installed.
