---
date: 2026-09-16
title: "Claim models before mutating runtime state"
---

# 2026-09-16 — Claim models before mutating runtime state

- **Context:** During the staged core migration, the desktop plugin and `atomic-chat-core` can use
  the same data folder. Mirroring ready sessions was one-way and happened after load, so two
  processes could both observe an idle model and start separate backends before either mirror was
  visible. The app startup reaper could also kill a core backend between spawn and journal write.
- **Decision:** Both runtimes atomically create
  `<data>/atomic-core/model-claims/<sha256(provider + NUL + model-id)>/claim.json` before loading.
  The claim records owner PID plus a cross-language process-start identity and moves from `loading`
  to `ready`; only its `claim_id` may release it. A proven-dead/reused owner is recoverable, while
  malformed or unprovable live ownership fails closed. The app reaper defers while a live core has
  a `loading` claim. `legacy-runtime.json` remains temporary discovery/diagnostic compatibility.
- **Consequences:** App-first and CLI-first races now have one winner before any backend or model
  state changes. The cost is one small directory and atomic metadata write per loaded model, plus
  platform-specific process-start probing. Claims must be released on load failure, unload,
  backend death, and owner shutdown; tests cover exclusivity and cleanup on both implementations.
- **Owner:** team
- **Links:** `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/model_claim.rs`,
  `../../../atomic-chat-core/src/lock/model-claim.ts`,
  [The core ships as a bundled resource](2026-09-15-the-core-is-a-bundled-resource-and-an-independent-owner.md)
