---
date: 2026-07-28
title: "Pin backend artifacts to verified tags"
---

# 2026-07-28 — Pin backend artifacts to verified tags

- **Context:** Atomic Chat builds process arguments against specific
  TurboQuant llama.cpp, upstream llama.cpp, and AtomicBot MLX capabilities.
  Following a moving latest release can silently remove flags, introduce new
  asset names, or expose fork-only options to the wrong provider.
- **Decision:** Production downloads use exact verified tags for all three
  backends. TurboQuant's per-platform tags are resolved from an immutable
  `atomic-chat-conf` revision. Updating a tag or manifest revision requires a
  dedicated compatibility change that verifies CLI flags, provider isolation,
  argument builders, and release asset names.
- **Consequences:** Normal builds are reproducible and a moving manifest cannot
  upgrade users implicitly. Backend updates require deliberate maintenance, and
  macOS x64 skips TurboQuant until that fork publishes and verifies an x64
  artifact.
- **Owner:** team
- **Links:** `Makefile`,
  `.github/workflows/release.yml`,
  `extensions/llamacpp-upstream-extension/src/backend.ts`,
  `extensions/llamacpp-extension/src/backend.ts`,
  `docs/testing-critical-flows.md`
