---
date: 2026-05-27
title: "System Monitor falls back to NVML/Vulkan when `--list-devices` is empty; fix NVIDIA dup-log spam and the missing `refresh_system_info` ACL"
---

# 2026-05-27 — System Monitor falls back to NVML/Vulkan when `--list-devices` is empty; fix NVIDIA dup-log spam and the missing `refresh_system_info` ACL

- **Context:** Two new Discord reports confirmed that the 2026-05-26
  work (driver-gate precision + tier-picker corroboration guard +
  `DriverOutdatedBanner`) did not move the user-visible symptom on
  the affected cohort:
    - **Xenix** — RTX 4090 Laptop, Win 11 Pro, driver `596.49`, CUDA
      13.2, i9-14900HX, 128 GiB RAM. `nvidia-smi` shows
      `llama-server.exe` running as a Compute (`C`) process with
      15.6 / 16.4 GiB VRAM in use, yet System Monitor still says
      "No GPUs detected".
    - **killinkluck** — AMD RX 7900 XTX (24 GiB), Win 11 Pro,
      Ryzen 9 5950X. Same UI symptom, and the user explicitly
      reports "I do see GPU utilization when using, just not visible
      in the UI" — i.e. the Vulkan backend is decoding on the GPU
      but the Active GPUs panel pretends nothing is there.

  Root cause is in the **UI layer**, not the backend picker the
  2026-05-26 ADR addressed:
  [`web-app/src/routes/system-monitor.tsx`](web-app/src/routes/system-monitor.tsx)
  and [`web-app/src/routes/settings/hardware.tsx`](web-app/src/routes/settings/hardware.tsx)
  both used `llamacppDevices.length === 0` (the parsed stdout of
  `llama-server.exe --list-devices`) as the **single** source of
  truth for the Active GPUs panel. The 2026-05-26 corroboration
  guard for `tierEnumeratesDevices` only ran in
  `detectIdealBackendType()` — it stopped the backend picker from
  misbehaving but did not fix the cosmetic UI bug, which is exactly
  what end users notice.

  Two collateral bugs surfaced while we were here:
    1. **`get_usage_nvidia called on non-NVIDIA GPU` log spam.**
       [`tauri-plugin-hardware/src/commands.rs::compute_system_info`](src-tauri/plugins/tauri-plugin-hardware/src/commands.rs)
       deduplicates GPUs by `uuid`, but NVML's CUDA UUID and
       Vulkan's `VkPhysicalDeviceIDProperties.deviceUUID` are
       **not guaranteed to be byte-identical for the same physical
       NVIDIA card** (a documented NVIDIA quirk). On hosts where
       they differ, one RTX 4090 ends up as two map entries — one
       NVML-sourced (`nvidia_info: Some`), one Vulkan-sourced
       (`vendor: NVIDIA` via PCI vendor_id 0x10DE,
       `nvidia_info: None`). Every 5 s `get_system_usage` poll
       called `get_usage_nvidia` on the Vulkan duplicate, tripped
       the `nvidia_info.is_none()` branch, and spammed
       `log::error!("called on non-NVIDIA GPU")` — wrong message
       (the card IS NVIDIA) and infinite noise.
    2. **`Command plugin:hardware:refresh_system_info not allowed
       by ACL`.** [`tauri-plugin-hardware/build.rs`](src-tauri/plugins/tauri-plugin-hardware/build.rs)
       had `const COMMANDS: &[&str] = &["get_system_info",
       "get_system_usage"]`, missing `refresh_system_info`. The
       command was wired in
       [`lib.rs::init`](src-tauri/plugins/tauri-plugin-hardware/src/lib.rs)
       and called from
       [`web-app/src/services/hardware/tauri.ts`](web-app/src/services/hardware/tauri.ts)
       on every visibility change, but `tauri_plugin::Builder` had
       never generated an autogen permission TOML for it, so the
       default permission set didn't allow it.

- **Decision:**
    1. **UI fallback (Fix C / Bug #1).** When `llamacppDevices` is
       empty AND `hardwareData.gpus.length > 0`, render the GPUs
       the hardware plugin sees, with a subdued note
       (`system-monitor:liveStatsUnavailable`, EN + RU; other
       locales fall back to EN) clarifying that live VRAM stats
       are limited but the GPU is still usable. New helper
       [`web-app/src/lib/gpuFallback.ts`](web-app/src/lib/gpuFallback.ts)
       exports `buildFallbackDevices(gpus)` which dedupes by
       `(vendor, name, total_memory)` — a safe UI-side dedup that
       collapses the NVML/Vulkan duplicate from Bug #2 for the
       single-physical-GPU case (99% of hosts) while leaving
       multi-GPU rigs with two identical cards slightly wrong
       (queued as future ADR follow-up; see Future Work below).
       Fallback cards omit `free` / `used` because (a) the
       Vulkan-sourced duplicate has no matching `systemUsage.gpus[]`
       entry post-Fix B and (b) the `--list-devices` code path that
       normally provides per-device free VRAM is the very thing
       we're routing around. The misleading "No GPUs detected"
       message now only shows when both signals agree (neither
       `--list-devices` nor NVML/Vulkan see anything).
    2. **Dispatch guard for the dup-spam (Fix B / Bug #2).**
       [`tauri-plugin-hardware/src/gpu.rs::GpuInfo::get_usage`](src-tauri/plugins/tauri-plugin-hardware/src/gpu.rs)
       now matches on `Vendor::NVIDIA if self.nvidia_info.is_some()`
       — Vulkan-only NVIDIA entries (the duplicate) fall through to
       `get_usage_unsupported` silently. The now-unreachable guard
       inside `get_usage_nvidia`
       ([`vendor/nvidia.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs))
       is kept as defense-in-depth but its `log::error!` was
       downgraded to `log::trace!` with an explanatory comment.
       The underlying UUID-mismatch dedup is **not** fixed by this
       ADR — that needs PCI-BDF-based reconciliation across
       NVML / Vulkan / Win32_VideoController and is queued as
       separate work (Fix D in the 2026-05-27 plan); the current
       dedup behaviour in `commands.rs` is preserved unchanged.
    3. **Missing ACL (Fix A / Bug #3).** Added `"refresh_system_info"`
       to `COMMANDS` in
       [`tauri-plugin-hardware/build.rs`](src-tauri/plugins/tauri-plugin-hardware/build.rs),
       added `"allow-refresh-system-info"` to
       [`permissions/default.toml`](src-tauri/plugins/tauri-plugin-hardware/permissions/default.toml),
       and committed the matching autogen
       `permissions/autogenerated/commands/refresh_system_info.toml`
       so the fix is self-contained. The `reference.md` and
       `permissions/schemas/schema.json` were regenerated by the
       tauri build that happened during local verification. All
       five existing capability files in `src-tauri/capabilities/`
       already include `"hardware:default"` and therefore pick up
       the new permission with no further edits.

- **Consequences:**
    - **End-user-visible.** Xenix and killinkluck (and anyone in
      their cohort) will now see their GPU in System Monitor and
      Settings → Hardware, with the subdued note explaining live
      VRAM stats are limited. Inference path is unchanged — the
      backend picker still routes through the 2026-05-26 health
      check; we only fixed what we **display**.
    - **Log noise gone.** On Xenix-class hosts (Bug #2 cohort), the
      NVIDIA dup spam stops immediately on next launch. No log
      throttling required.
    - **Visibility-refresh works.** The previously-failing
      `plugin:hardware:refresh_system_info` invocation now succeeds,
      restoring the post-resume / post-tab-focus GPU re-detection
      that was silently broken.
    - **No silent fallback to CPU regressions.** The corroboration
      guard from the 2026-05-26 ADR is unchanged. The new UI
      fallback only changes what we display.
    - **NOT fixed by this ADR (deliberately):**
        - The underlying NVML/Vulkan UUID dedup quirk — multi-GPU
          rigs with two identical NVIDIA cards will still see a
          single collapsed entry in the fallback view. Single-GPU
          and mixed-card multi-GPU setups are unaffected. Fix D
          (PCI-BDF-based dedup) is the proper follow-up.
        - The two-code-paths divergence in `llama-server.exe`
          (why `--list-devices` returns empty while real inference
          works) — needs `--list-devices` stderr from an affected
          host. The diagnostics collector
          [`scripts/collect-windows-gpu-diag.ps1`](scripts/collect-windows-gpu-diag.ps1)
          captures exactly this; we're waiting on the .zip from
          Xenix / killinkluck.
        - Manual backend override UI (m.iko feature request) — out
          of scope for this round.

- **Owner:** team.
- **Links:** Discord support thread 2026-05-26/27 (Xenix:
  RTX 4090 Laptop / drv 596.49 / CUDA 13.2; killinkluck:
  RX 7900 XTX), the 2026-05-26 ADR *Correct CUDA 13.1 driver
  gate …*,
  files: [`web-app/src/routes/system-monitor.tsx`](web-app/src/routes/system-monitor.tsx),
  [`web-app/src/routes/settings/hardware.tsx`](web-app/src/routes/settings/hardware.tsx),
  [`web-app/src/lib/gpuFallback.ts`](web-app/src/lib/gpuFallback.ts),
  [`web-app/src/locales/en/system-monitor.json`](web-app/src/locales/en/system-monitor.json),
  [`web-app/src/locales/ru/system-monitor.json`](web-app/src/locales/ru/system-monitor.json),
  [`src-tauri/plugins/tauri-plugin-hardware/src/gpu.rs`](src-tauri/plugins/tauri-plugin-hardware/src/gpu.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/build.rs`](src-tauri/plugins/tauri-plugin-hardware/build.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/permissions/default.toml`](src-tauri/plugins/tauri-plugin-hardware/permissions/default.toml),
  [`src-tauri/plugins/tauri-plugin-hardware/permissions/autogenerated/commands/refresh_system_info.toml`](src-tauri/plugins/tauri-plugin-hardware/permissions/autogenerated/commands/refresh_system_info.toml),
  [`scripts/collect-windows-gpu-diag.ps1`](scripts/collect-windows-gpu-diag.ps1)
  (diagnostics collector still pending data from affected users).
