---
date: 2026-05-26
title: "Correct CUDA 13.1 driver gate to NVIDIA-documented `581.15` and add runtime `--list-devices` health-check as self-healing degrade for the Windows tier picker"
---

# 2026-05-26 — Correct CUDA 13.1 driver gate to NVIDIA-documented `581.15` and add runtime `--list-devices` health-check as self-healing degrade for the Windows tier picker

- **Context:** Multiple bug reports
  ([AtomicBot-ai/Atomic-Chat#25](https://github.com/AtomicBot-ai/Atomic-Chat/issues/25),
  [janhq/jan#7553](https://github.com/janhq/jan/issues/7553),
  [ggml-org/llama.cpp#19868](https://github.com/ggml-org/llama.cpp/issues/19868))
  surfaced "No GPUs detected" on Windows for high-end NVIDIA cards
  (RTX 4090 Laptop, 5090). System Monitor's `noGpus` label is driven by
  `llamacppDevices.length === 0` (the parsed stdout of
  `llama-server.exe --list-devices` for the currently-selected backend),
  not by raw `hardwareData.gpus` enumeration. So the user-visible
  message fires whenever the chosen backend's binary loads but its
  `cuInit()` returns zero devices — not when NVML/Vulkan can't see the
  card. Two separate driver-class root causes were observable:
    1. **H1 — `cuda-13.1` binary on a driver below the documented CUDA
       Toolkit 13.1 minimum (Windows `581.15`).** Our static driver gate
       `min_cuda13_driver` was `"581"` (effectively `>= 581.00`), a
       0.15 below the NVIDIA-published floor. Drivers in the narrow
       `581.00–581.14` band passed our gate but failed `cuInit()` at
       runtime → empty `--list-devices` → "No GPUs detected".
    2. **H7 — Drivers in `528.xx–550.xx`** (NVIDIA Studio Driver 528 /
       537 / 546, GameReady 531 / 536 / 546, corporate WHQL, OEM
       pre-installs) silently lost CUDA entirely after the
       2026-05-22 ADR *Windows ships only `llamacpp-upstream`* bumped
       `min_cuda12_driver` from `527.41` (CUDA 12.0, supported by the
       legacy janhq mirror) to `551.61` (CUDA 12.4, ggml-org's lowest
       Windows CUDA tier). These users fell back to `win-cpu-x64` with
       no UI signal telling them to update the driver.

  Independent of the driver root cause, both H1 and H7 produced the
  same opaque symptom because `detectIdealBackendType()` had no
  health-check — it picked the highest tier the static gate allowed
  and `recheckOptimalBackend()` returned `null` ("already on optimal
  category") whenever the persisted `version_backend` already matched
  the picked category, even if the corresponding binary couldn't
  actually enumerate any device. Once a broken `cuda-13.1` was
  persisted, the user was stuck on it forever without manual
  intervention.

- **Decision:**
    1. **Bump `min_cuda13_driver` for Windows from `"581"` to `"581.15"`**
       in [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs),
       matching the NVIDIA CUDA Toolkit 13.1 Release Notes exactly.
       Linux and the turboquant plugin's thresholds unchanged. New
       boundary tests cover `581.14` (rejected), `581.15` (accepted),
       `581.42` (accepted — typical recent driver), `550.00` (rejected
       for both CUDA tiers — H7), and `551.61` (CUDA 12.4 only).
    2. **Add a runtime `--list-devices` health-check** to the Windows
       tier picker, **guarded by a corroborating-GPU check** against the
       hardware plugin (NVML / Vulkan). New private method
       `tierEnumeratesDevices(backendType, sysInfo)` in
       [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
       returns a tri-state — `'works' | 'unverified' | 'broken'`:
         - `'works'` — `--list-devices` returned ≥1 device;
         - `'unverified'` — tier is not installed yet, OR tier is
           installed and `--list-devices` is empty / threw BUT NVML /
           Vulkan corroborate a matching GPU (NVIDIA for cuda-*, any
           GPU for vulkan-*);
         - `'broken'` — tier is installed, `--list-devices` is empty /
           threw, AND the hardware plugin sees no matching GPU.
       `detectIdealBackendType()` on Windows now iterates the ordered
       tier list `[cuda-13.1?, cuda-12.4?, vulkan?]` and skips a tier
       only when it returns `'broken'` (two independent signals agree).
       Helper `hasCorroboratingGpu(backendType, sysInfo)` does the
       NVML / Vulkan match by reading `sysInfo.gpus[*].vendor` (matches
       the strings serialised by
       [`tauri-plugin-hardware/src/types.rs`](src-tauri/plugins/tauri-plugin-hardware/src/types.rs)).
       The probe is **non-destructive** — it never triggers a download
       — and is only invoked from the two existing user-facing entry
       points (`SetupBackendStep` on first launch and the manual
       "Find optimal backend" button in provider settings).
    3. **Surface the H7 cohort with a UI banner.** New
       [`web-app/src/containers/DriverOutdatedBanner.tsx`](web-app/src/containers/DriverOutdatedBanner.tsx)
       (with helper `findOutdatedNvidiaGpu` + Rust-mirror
       `compareDriverVersions`) is mounted in
       [`web-app/src/routes/system-monitor.tsx`](web-app/src/routes/system-monitor.tsx)
       and [`web-app/src/routes/settings/hardware.tsx`](web-app/src/routes/settings/hardware.tsx)
       conditionally on `hardwareData.gpus.length > 0 &&
       llamacppDevices.length === 0`. It identifies any NVIDIA GPU
       below the `551.61` floor and renders an actionable alert with a
       link to `https://www.nvidia.com/drivers`. i18n keys
       `system-monitor:driverOutdated.{title,description,updateAction}`
       added for EN + RU; other locales fall back to EN.
    4. **Promote diagnostic logs from `debug!` to `warn!`** in
       [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs)
       (NVML init failure, NVML not available) and enrich
       [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/vulkan.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/vulkan.rs)
       (mention `vulkan-1.dll` / `libvulkan.so` as the likely missing
       library) and
       [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/device.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/device.rs)
       (list three most common causes of an empty device list and
       point at the TS-side `tierEnumeratesDevices` as the consumer of
       this signal). Release-build logs (default `RUST_LOG=info`) now
       surface NVML / Vulkan loader failures and empty-enumeration
       events without needing a debug build.

- **Consequences:**
    - **Fix 1 is precision, not the primary user-visible fix.** The
      gate move from `"581"` to `"581.15"` affects only the narrow
      `581.00–581.14` driver band — typically beta / pre-release
      builds. The actual `cuInit()` failure observed in #25 (RTX 4090
      Laptop on a recent ≥581.15 driver) is *not* a driver-floor
      issue and is not fixed by Fix 1 alone. The most likely
      remaining cause for that cohort is NVIDIA Optimus / MUX-switch
      laptops where the dGPU is parked and `cuInit()` returns zero
      devices to a process started in the iGPU context. Fix 2 is the
      mechanism that rescues those users.
    - **Fix 2 makes the picker self-healing, but conservatively.** Two
      independent signals must agree before we degrade away from a
      tier: `--list-devices` must come back empty / throw AND the
      hardware plugin (NVML for CUDA, Vulkan loader for vulkan) must
      also fail to see a matching GPU. When that happens,
      `recheckOptimalBackend()` surfaces a recommendation to switch to
      the next tier — `cuda-13.1` → `cuda-12.4` → `vulkan` → `cpu`
      (terminal). The existing download-recommended-backend UI flow
      then carries the user through the upgrade. When `--list-devices`
      is empty but NVML / Vulkan corroborate a matching GPU, the tier
      is kept (`'unverified'`) and a single `info` log records the
      mismatch — the inference path uses its own CUDA init and is
      unaffected by `--list-devices` quirks (see Amendment below for
      the nvidia-smi evidence that motivated this guard). Cost: each
      already-installed tier costs one `--list-devices` invocation
      per `recheckOptimalBackend()` call — bounded at three tiers
      with a 30-second Rust-side timeout per call, so worst-case
      ~90s blocking for a host whose entire CUDA stack is broken.
      Probing is only triggered by the two existing user-facing entry
      points (`SetupBackendStep` on first launch, and the manual
      "Find optimal backend" button in provider settings) — there is
      no automatic background probe. A future ADR may add an
      auto-trigger when `hardwareData.gpus.length > 0 &&
      llamacppDevices.length === 0` is detected for >N seconds; for
      now this is a manual escalation step the banner from Fix 3
      drives the user to.
    - **Fix 3 makes the H7 cohort self-serve.** Users on drivers
      `528.xx–550.xx` previously saw a silent fallback to CPU. They
      now see a yellow actionable banner the moment they open
      System Monitor or Settings → Hardware. Cost: an extra check
      on every render of those screens, bounded by the size of
      `hardwareData.gpus` (typically 1–3) and `compareDriverVersions`
      runtime (microseconds). The banner is shown only when the
      symptom is present (`llamacppDevices.length === 0` AND a
      qualifying GPU is in `hardwareData.gpus`), so it cannot
      false-positive on healthy installs.
    - **Fix 4 makes user-shared logs informative.** The previous
      `debug!` level meant release-build logs were silent on NVML /
      Vulkan / `cuInit()` failures, forcing every bug report into a
      "please attach a debug-level log" round-trip. New `warn!` lines
      let triage start from the first user log.
    - **Backwards-compatible.** No persisted settings schema changes.
      No model migrations. No new IPC commands. No new on-disk paths.
      The new TS health-check uses the existing
      `plugin:llamacpp-upstream|get_devices` IPC, the existing
      `getLocalInstalledBackends`, and the existing
      `getBackendExePath`. macOS is unaffected (the early `IS_MAC`
      return in `recheckOptimalBackend` still bypasses the whole
      flow; the new tier-list code path is gated by
      `sysInfo.os_type === 'windows'`).
    - **Test coverage.** `cargo test` on the upstream plugin grew from
      27 to 31 backend tests; all 31 pass plus 126 plugin-wide tests.
      No new TS unit tests yet — `tierEnumeratesDevices` is
      integration-level (requires a real installed backend) and is
      covered by the manual test plan in the PR.

- **Amendment (same day) — nvidia-smi evidence narrowed Fix 2 scope:**
  After the four fixes landed, the #25 reporter shared `nvidia-smi`
  output from a representative affected host: **driver 596.49, CUDA
  13.2, RTX 4090 Laptop, WDDM mode, 15.6 / 16.4 GiB VRAM in use,
  `llama-server.exe` listed twice as a Compute (`C`) process.** This
  directly opposes the H1 root-cause for that host — the driver is
  well above `581.15`, CUDA 13.x ABI is fully supported, and the real
  inference path is already using the GPU successfully (VRAM is
  loaded, llama-server holds a Compute context). The "No GPUs
  detected" UI message and the empty `--list-devices` output must
  therefore come from a different code path than the inference one
  — most likely a parser quirk in
  [`tauri-plugin-llamacpp-upstream/src/device.rs::parse_device_output`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/device.rs),
  a cudart DLL search-path difference between the `--list-devices`
  invocation and the `load_session` invocation, or an environment /
  cwd mismatch between the two `Command::new("llama-server.exe")`
  call sites. Without that guard, the original Fix 2 (degrade on
  empty `--list-devices` alone) would have pushed this user — and
  the whole cohort he represents — off a **working** CUDA-13.1 onto
  CUDA-12.4 / Vulkan / CPU, making the bug worse. The
  corroborating-GPU guard added in this amendment ensures
  `tierEnumeratesDevices` returns `'unverified'` (not `'broken'`)
  when NVML still reports the matching NVIDIA GPU, so the picker
  keeps the working tier. Fix 2 still degrades when both signals
  agree — i.e. when the binary really cannot use any GPU (no NVML
  detection AND empty `--list-devices`). Outstanding follow-up to
  fully close #25 (separate from this ADR): capture stderr of
  `llama-server.exe --list-devices` on an affected host and decide
  between (a) hardening the stdout parser, (b) preferring NVML /
  Vulkan as the authoritative source for the System Monitor
  "Active GPUs" panel, or (c) both.

- **Owner:** team.
- **Links:** [AtomicBot-ai/Atomic-Chat#25](https://github.com/AtomicBot-ai/Atomic-Chat/issues/25),
  [janhq/jan#7553](https://github.com/janhq/jan/issues/7553),
  [ggml-org/llama.cpp#19868](https://github.com/ggml-org/llama.cpp/issues/19868),
  [ggml-org/llama.cpp release b9334](https://github.com/ggml-org/llama.cpp/releases/tag/b9334)
  (confirms `Windows x64 (CUDA 13) - CUDA 13.1 DLLs` shipping
  artifact),
  NVIDIA CUDA Toolkit 13.1 Release Notes (Windows minimum driver
  `581.15`), the 2026-05-22 ADR *Windows ships only `llamacpp-upstream`*,
  files: [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs),
  [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts),
  [`web-app/src/containers/DriverOutdatedBanner.tsx`](web-app/src/containers/DriverOutdatedBanner.tsx),
  [`web-app/src/routes/system-monitor.tsx`](web-app/src/routes/system-monitor.tsx),
  [`web-app/src/routes/settings/hardware.tsx`](web-app/src/routes/settings/hardware.tsx),
  [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/nvidia.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/src/vendor/vulkan.rs`](src-tauri/plugins/tauri-plugin-hardware/src/vendor/vulkan.rs),
  [`src-tauri/plugins/tauri-plugin-hardware/src/types.rs`](src-tauri/plugins/tauri-plugin-hardware/src/types.rs)
  (source of truth for `vendor` strings consumed by
  `hasCorroboratingGpu`),
  [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/device.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/device.rs).
