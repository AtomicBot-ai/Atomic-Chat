---
date: 2026-10-07
title: 'Port privacy, GPU telemetry, and benchmarking through Radium-native boundaries'
---

# 2026-10-07 — Port privacy, GPU telemetry, and benchmarking through Radium-native boundaries

- **Context:** `walladanger/ClaudeDesktopClient` has useful privacy-redaction, GPU-monitoring, and benchmark behavior, but its implementation is coupled to Electron IPC and `nvidia-smi`. Radium already has a Tauri hardware service, an NVML-backed native plugin, a System Monitor route, and a single `streamText` chat egress path.
- **Decision:** Port the capabilities rather than the Electron wiring. Apply the privacy gate at Radium's remote `streamText` egress boundary with request-scoped placeholders and local response/tool rehydration; local providers bypass it. Extend the existing NVML hardware plugin for NVIDIA utilization, temperature, power, and clocks while preserving explicit unavailable-vs-zero semantics. Keep benchmarking explicit and local-only in System Monitor, with repeatable statistics, saved history, and a user-selected baseline; unavailable engines skip with a reason rather than scoring zero.
- **Consequences:** Radium gets one privacy boundary for normal remote chat, richer per-GPU telemetry without spawning `nvidia-smi`, and benchmarks that can compare local inference/runtime changes. The privacy gate is user-controlled and off by default so a migration does not silently alter cloud prompts. GPU fields are optional in the TypeScript contract for compatibility with older native payloads. This change does not add Blender as a runtime dependency or start heavy workloads automatically.
- **Owner:** @walladanger
- **Links:** `web-app/src/lib/privacy-gate.ts`, `web-app/src/lib/custom-chat-transport.ts`, `src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs`, `web-app/src/routes/system-monitor.tsx`, `web-app/src/lib/performance-benchmark.ts`
