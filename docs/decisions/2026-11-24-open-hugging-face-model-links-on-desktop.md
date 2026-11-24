---
date: 2026-11-24
title: "Open Hugging Face model links on desktop"
---

# Open Hugging Face model links on desktop

Hugging Face links identify a repository with `atomic-chat://models/huggingface/<owner>/<repo>`. Windows and Linux declare the scheme in their Tauri configs. Linux distribution packages also advertise it in their desktop entry and pass a single URL to the binary. An AppImage can register itself on first launch. Registration errors are logged so that a missing desktop utility does not prevent startup. E2E binaries skip runtime registration.

macOS registers the scheme in `Info.plist`. On all three desktop platforms, cold starts and links opened while the app is running use the same Hub route.

The Hub uses the repository's files and engine metadata to open its card. A generative safetensors checkpoint, including NVFP4, can come from the catalog or from a Hugging Face lookup. Where a managed engine is available, it reports compatibility. Otherwise the card labels the weights as Safetensors and explains the missing engine or its reported hardware blocker.

Hugging Face controls which model pages offer Atomic Chat in the “Use this model” menu. That selection lives in `packages/tasks/src/local-apps.ts` in `huggingface/huggingface.js`.

This extends [the original safetensors decision](2026-10-12-open-a-linked-safetensors-repository-as-a-managed-checkpoint.md) and incorporates [PR #373](https://github.com/AtomicBot-ai/Atomic-Chat/pull/373).
