---
date: 2026-07-29
title: "Derive the actually-used device from llama-server startup logs, not `--list-devices`"
---

# 2026-07-29 — Derive the actually-used device from llama-server startup logs, not `--list-devices`

- **Context:** users reported settings showing a CUDA backend while inference
  clearly ran on the CPU. Two independent causes existed, and neither was
  observable: (1) `resolveBackendFallback` tier 3 in the upstream extension swaps
  `this.config.version_backend` to any installed backend (usually the bundled CPU
  build) and deliberately does not persist it, so the settings dropdown keeps
  showing the previous pick; (2) when a CUDA build cannot find a CUDA runtime the
  Rust plugin only logged `log::warn!` and started the process anyway, after
  which llama.cpp silently ran on the CPU. Nothing in the tree knew which device
  a loaded model actually used. `--list-devices` was the only device signal
  available, and it reports what a *binary can enumerate*, not what the *loaded
  model runs on* — it is already documented to return an empty list on hosts
  where inference does run on the GPU (see the `parse_device_output` comment in
  each plugin's `device.rs`). It also costs an extra process spawn.
- **Decision:** treat the startup log of the already-running `llama-server`
  process as the source of truth. A new `runtime_device.rs` in each of
  `tauri-plugin-llamacpp` and `tauri-plugin-llamacpp-upstream` parses
  `load_backend: loaded X backend`, `load_tensors: offloaded N/M layers to GPU`
  and `load_tensors: <LABEL> model buffer size` out of the lines the existing
  stdout/stderr reader tasks already stream, and stores the result on
  `SessionInfo.runtime_device` (plus a `get_runtime_device(pid)` command for a
  late re-snapshot). The extensions classify the result against the persisted and
  the launched backend in `classifyBackendMismatch` (`silent-fallback` /
  `runtime-cpu` / `suboptimal-config`), emit
  `AppEvent.onBackendRuntimeReported`, and the web-app raises a dialog on the
  first message send after the load — detection at load time, prompt at send
  time, so a load is never interrupted and a send is never blocked. The event
  carries the verdict of *every* load, `kind: 'ok'` included, because a healthy
  load is the only reliable signal that a warning the user has since acted on may
  be retired.
- **Consequences:** the "actually running" backend is now displayable next to the
  `version_backend` dropdown, and a missing CUDA runtime becomes an actionable
  hint instead of a silent slowdown. Nothing in the parser is CUDA-specific: the
  buffer labels are split into CPU and non-CPU, so `Vulkan0` — the only GPU path
  for AMD and Intel, and the sole GPU path on Linux — is detected exactly like
  `CUDA0`. Only the *advice* is stack-specific, carried by `gpuKind` on the
  `runtime-cpu` verdict: CUDA needs a separate runtime install and says so from
  the `binary_requires_cuda` probe, while Vulkan comes from the graphics driver
  and is therefore worded as a likely cause rather than an established one.
  Metal is deliberately outside the `runtime-cpu` class: macOS backend ids do
  not map to a GPU category, and Metal is always present on Apple Silicon. Zero
  offloaded layers is only evidence of degradation when layers were asked for:
  the "GPU Layers" model setting documents 0 as CPU-only, so `-ngl 0` suppresses
  the verdict rather than accusing the user of their own choice. The cost is a coupling to llama.cpp log
  wording; the parser is deliberately tolerant (matches stable substrings, treats
  an unrecognised log as inconclusive rather than as CPU, and accepts the legacy
  `llm_load_tensors:` prefix) and is covered by unit tests over real CUDA /
  Vulkan / Metal / CPU output. `is_ready_log_line` in the same file documents the
  precedent: upstream has silently reworded startup lines before, so any future
  rewording must be caught by these tests rather than by a user report. The
  "better tier available" input is read from the recommendation the existing
  detect flows already stored, never from a fresh probe, so the load path pays
  nothing. Both plugins and both extensions carry mirrored copies, consistent
  with how `backend.rs` / `device.rs` are already duplicated.
- **Owner:** team
- **Links:**
  - `src-tauri/plugins/tauri-plugin-llamacpp{,-upstream}/src/runtime_device.rs`
  - `extensions/llamacpp{,-upstream}-extension/src/util.ts` (`classifyBackendMismatch`)
  - `web-app/src/hooks/useBackendMismatch.ts`,
    `web-app/src/containers/dialogs/SuboptimalBackendDialog.tsx`
  - janhq/jan#7121 (same class of bug upstream)
