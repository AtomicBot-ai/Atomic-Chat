---
date: 2026-09-15
title: "Sign the core with JIT entitlements and verify the universal artifact"
---

# 2026-09-15 — Sign the core with JIT entitlements and verify the universal artifact

- **Context:** The core is a Bun single-file executable, so JavaScriptCore compiles code at
  runtime. Under macOS Hardened Runtime — which notarization requires — a binary without JIT
  entitlements dies at startup with "Ran out of executable memory", and the failure only appears in
  a signed, notarized build, not in development.
- **Decision:** `src-tauri/Entitlements.sidecar.plist` grants `com.apple.security.cs.allow-jit`,
  `com.apple.security.cs.allow-unsigned-executable-memory` (Bun also maps writable-then-executable
  pages) and `com.apple.security.cs.disable-library-validation` (the core spawns `llama-server`,
  which dlopens ggml and CUDA libraries by name). `make build-cli` signs the copied binary with
  that file and runs `codesign --verify --strict`. The app's own bundle keeps
  `Entitlements.plist`; the sidecar file exists so the core's extra permissions are not granted to
  the whole app.
- **Consequences:** Release verification must run the *final, signed, notarized* universal artifact
  on both arm64 and x64 and execute the bundled CLI there — entitlements present in a plist prove
  nothing on their own. A future runtime change (Node SEA, a different packager) revisits this
  file. Linux and Windows need no equivalent.
- **Owner:** team
- **Links:** `src-tauri/Entitlements.sidecar.plist`, `Makefile` (`build-cli-core`),
  `../../../atomic-chat-core/PLAN.md` (§6 risk 4)
