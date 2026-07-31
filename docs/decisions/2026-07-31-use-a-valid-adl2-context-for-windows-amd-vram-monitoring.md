---
date: 2026-07-31
title: "Use a valid ADL2 context for Windows AMD VRAM monitoring"
---

# 2026-07-31 — Use a valid ADL2 context for Windows AMD VRAM monitoring

- **Context:** Windows AMD GPU discovery and total VRAM enumeration work through Vulkan, but live VRAM polling fails because the hardware plugin resolves non-existent camel-cased ADL exports and calls an ADL2 query with a null context. The always-on five-second status poll then repeats a non-actionable debug message.
- **Decision:** Use the documented ADL2 exports and one context lifecycle for enumeration and dedicated-VRAM queries. Serialize ADL calls, release the context through RAII on every exit path, check every ADL status, and log repeated probe failure only once per process.
- **Consequences:** Windows AMD live VRAM telemetry can operate independently of Vulkan discovery without flooding logs. The implementation remains dependent on the AMD driver-provided ADL DLL and still falls back to unavailable live statistics when ADL cannot initialize.
- **Owner:** team
- **Links:** [Atomic Chat #195](https://github.com/AtomicBot-ai/Atomic-Chat/issues/195), [Jan #8390](https://github.com/janhq/jan/pull/8390), [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/amd.rs`](../../src-tauri/plugins/tauri-plugin-hardware/src/vendor/amd.rs), [AMD ADL documentation](https://gpuopen-librariesandsdks.github.io/adl/adl_8h.html)
