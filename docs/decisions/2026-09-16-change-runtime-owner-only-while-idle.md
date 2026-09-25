---
date: 2026-09-16
title: "Change the inference runtime owner only while it is idle"
---

# 2026-09-16 — Change the inference runtime owner only while it is idle

- **Context:** Stage 3b lets Atomic Chat hand `llamacpp-upstream` process ownership to `atomic-chat-core` and roll it back at runtime. Either side can also be used independently, so a model loaded by the outgoing owner may belong to an app flow or CLI invocation that did not request the handover.
- **Decision:** Change the active owner only after the outgoing runtime has no active or loading sessions. Serialize the handover with both core control calls and legacy plugin loads, install a fresh core snapshot before selecting the core, and reject the flag change instead of unloading models automatically.
- **Consequences:** A completed handover has one authoritative resolver and cannot strand a request on the former owner's port. Users must explicitly unload models before changing the flag; this is intentional because the app cannot prove that an independently loaded model is safe to terminate.
- **Owner:** team
- **Links:** `src-tauri/src/core/atomic_core/commands.rs`, `src-tauri/src/core/sessions/resolver.rs`, `src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/state.rs`
