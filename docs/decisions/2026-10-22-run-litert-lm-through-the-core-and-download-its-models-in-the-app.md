---
date: 2026-10-22
title: "Run LiteRT-LM through the core; download its models from Hugging Face in the app"
---

# 2026-10-22 — Run LiteRT-LM through the core; download its models from Hugging Face in the app

- **Context:** Google LiteRT-LM runs `.litertlm` models (Gemma 4 and others) on the CPU, the GPU
  (Metal, WebGPU) and an Intel NPU through OpenVINO (openspec change `add-litert-lm-runtime`). Core
  0.19.0 installs its library from PyPI wheels as an engine build, runs each model in a
  `litert-host` process of the core binary with its own OpenAI server behind a keyed loopback
  gateway, decides on which hosts the provider exists, prepares OpenVINO only when a client asks,
  and checks a variant or a downloaded file (`POST /models/litert-lm/check`). The core downloads no
  model files (core ADR 2026-10-15).
- **Decision:** `extensions/litert-lm-extension` ships on every desktop OS and shows the provider
  exactly when the core's `POST /engines/versions` lists `litert-lm`. The provider page installs and
  updates the library and, where the core lists `openvino`, prepares it once by itself after an
  install or update. The Hub's "LiteRT-LM" format lists conf's curated list
  (`models/litert-lm-models.json`) and then the `litert-lm` repositories of conf's Hugging Face
  organisations, marked "not verified by Atomic Chat", with variants built from file names by the
  same rule as `atc` and only for the backends conf allows on this platform. The app downloads a
  variant's one file from `huggingface.co/<repo>/resolve/<revision>/<path>` with size and sha256 (the
  LFS metadata for Hugging Face models), the person's HF token for Hugging Face hosts only, asks the
  core to check the file, and writes `model.yml` last; a Hugging Face model's abilities come from
  that check. Chat goes to the session gateway with the fields the host reads; images follow the
  model's `vision`.
- **Consequences:** a refused gated download or a file the core refuses leaves no folder. The token
  not following Hugging Face's redirect to its CDN rests on reqwest dropping `Authorization` across
  hosts, pinned by a Rust test. Gemma 4 files declare no tool calling, so a Gemma 4 from Hugging Face
  (not the curated one) gets `tools: false` and stays out of Agent mode until the spec settles a rule
  above the file's flag. The Hub reads up to 50 repositories per view from the Hugging Face API, once
  per session.
- **Owner:** `team`
- **Links:** `extensions/litert-lm-extension/src/index.ts`,
  `web-app/src/services/litert-lm/{curated,huggingface,install,core}.ts`,
  `web-app/src/containers/litert-lm/`, `web-app/src/containers/hub/LiteRtLmDownloadOptions.tsx`,
  `src-tauri/src/core/agent/target.rs`, `src-tauri/src/core/downloads/tests.rs`,
  `atomic-chat-spec/openspec/changes/add-litert-lm-runtime/` (design, `rulings/app.md`).
