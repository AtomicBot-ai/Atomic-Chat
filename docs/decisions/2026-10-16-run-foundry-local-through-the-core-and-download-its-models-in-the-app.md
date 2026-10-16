---
date: 2026-10-16
title: "Run Foundry Local through the core; download its models in the app"
---

# 2026-10-16 — Run Foundry Local through the core; download its models in the app

- **Context:** Microsoft Foundry Local (ONNX Runtime GenAI) brings NPU accelerators (OpenVINO, QNN,
  Vitis AI through Windows ML), CUDA, WebGPU and CPU (openspec change `add-foundry-local`). The core
  installs its runtime as an engine build, runs each model in a `foundry-host` process of the core
  binary behind a keyed loopback gateway, and decides on which hosts the provider exists. The core
  downloads no model files (core ADR 2026-10-15).
- **Decision:** `extensions/foundry-local-extension` ships on every desktop OS and shows the provider
  exactly when the core's `POST /engines/versions` lists `foundry-local` — no platform check in the
  app, and no accelerator probe at start (it loads Microsoft's library). The app downloads variants
  itself: conf's curated list (`models/foundry-local-models.json`, size and sha256) and Microsoft's
  `asset-gallery` catalog (size only, marked "not verified by Atomic Chat"), resolved through conf's
  resolver template to a short-lived Azure SAS link, one `download_files` task per variant with a
  `resume_key` per file so an expired link (403) is resolved again without losing bytes, and
  `model.yml` written last with the `foundry_local` block the core loads by. Chat goes to the session
  gateway with OpenAI fields only; accelerators are prepared only from the provider page.
- **Consequences:** `DownloadItem.resume_key` is a new optional field of the Rust downloader
  (without it, a partial is matched by URL as before). The app depends on two undocumented Azure
  endpoints whose URLs live in conf; a changed answer format needs an app release. The macOS app core
  is signed with `disable-library-validation` in the last signing pass too, because Microsoft signs
  the Foundry Local dylibs. Agent-mode wiring exists (a gateway target that sends no reasoning
  fields) but is dormant while Agent mode is hidden.
- **Owner:** `team`
- **Links:** `extensions/foundry-local-extension/src/index.ts`,
  `web-app/src/services/foundry-local/{curated,microsoft-catalog,install,core}.ts`,
  `web-app/src/containers/foundry-local/`, `web-app/src/containers/hub/FoundryLocalDownloadOptions.tsx`,
  `src-tauri/src/core/downloads/models.rs` (`resume_key`), `src-tauri/scripts/sign-macos-resource-binaries.sh`,
  `atomic-chat-spec/openspec/changes/add-foundry-local/` (design, `rulings/app.md`).
