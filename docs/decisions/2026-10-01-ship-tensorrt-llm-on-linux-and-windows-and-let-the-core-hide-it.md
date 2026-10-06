---
date: 2026-10-01
title: "Ship TensorRT-LLM on Linux and Windows and let the core hide it"
---

# 2026-10-01 — Ship TensorRT-LLM on Linux and Windows and let the core hide it

- **Context:** `@janhq/tensorrt-llm-extension` was built only by `build:extensions:linux` (2026-09-30, "TensorRT-LLM is a Linux-only extension that decides its own visibility"). `atomic-chat-core` now also runs TensorRT-LLM on Windows 11 x64, in Atomic Chat's own WSL2 distribution (openspec change `add-tensorrt-llm-windows`). Windows on ARM is not supported, and until the Windows environment manifest (`runtimes/environments/windows.json`) is merged into `atomic-chat-conf` main after a live acceptance, no Windows user should be offered the engine (design D14).
- **Decision:** `build:extensions:win32` no longer `--exclude`s the extension; only macOS does. The app gates on the OS alone: the extension and `useManagedEnvironmentSync` run on Linux and Windows, and everything else — the architecture, the Windows build, the published manifest, the NVIDIA card — is the core's probe. The core answers `unsupported` for Windows on ARM (`unsupported-architecture`), a build below the manifest's minimum (`windows-build-too-old`) and a missing manifest with no distribution of ours yet (`environment-manifest-unavailable`), and `isProviderHidden` already hides every `unsupported` plan. The Model Hub hint follows the provider's visibility and the core's snapshot, so it needs no platform check either.
- **Consequences:** The extension ships to every Windows user before the acceptance, but stays hidden until conf publishes `windows.json` — the switch is data, not a release. A Windows ARM build carries an extension that never shows. A wrong core answer on Windows would show the provider; the core's own tests pin those answers (`windows-provisioner.test.ts`).
- **Owner:** `team`
- **Links:** `package.json` (`build:extensions:*`), `tests/pre-install-tarballs.test.mjs`, `extensions/tensorrt-llm-extension/src/visibility.ts`, `web-app/src/hooks/useManagedEnvironmentSync.ts`; `atomic-chat-spec` change `add-tensorrt-llm-windows` (spec `tensorrt-llm-desktop`, design D14, task 3.1).

<!--
Supersedes: 2026-09-30-tensorrt-llm-is-a-linux-only-extension-that-decides-its-own-visibility.md
-->
