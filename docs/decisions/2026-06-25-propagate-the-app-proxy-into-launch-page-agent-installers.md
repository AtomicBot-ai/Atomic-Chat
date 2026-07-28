---
date: 2026-06-25
title: "Propagate the app proxy into Launch-page agent installers, refresh the Windows PATH at install/detect time, and stop \"Find optimal backend\" picking Vulkan on integrated-only iGPUs"
---

# 2026-06-25 — Propagate the app proxy into Launch-page agent installers, refresh the Windows PATH at install/detect time, and stop "Find optimal backend" picking Vulkan on integrated-only iGPUs

- **Context:** Three Windows-confirmed defects from a user log + screenshots.
 (Class I) External coding-agent install on the Launch page failed with
 `'npm' not found on PATH`: `apply_login_path` is a no-op on Windows and the
 process PATH is snapshotted once at startup via `fix_path_env::fix()`, so a
 Node/npm installed after launch (or present in the registry but not the GUI
 PATH) stayed invisible to the spawned installer. (Class II) Installs also
 failed with GitHub DNS/tunnel errors (`os error 11001` / `WSAHOST_NOT_FOUND`):
 the app proxy lives only in `localStorage` (`setting-proxy-config`) and was
 applied solely to in-app HTTP clients via `getProxyConfig()` — the
 `install_agent` / `open_agent_terminal` subprocesses (npm / uv / PowerShell)
 inherited no proxy env, and the user was on a SOCKS5 `127.0.0.1:10808` proxy.
 (P3) `detectIdealBackendType` in both llama.cpp extensions picked the Vulkan
 tier on `features.vulkan && hasEnoughVram(>=6 GiB)` with no vendor/integrated
 check, so an Intel UHD (shared ~8 GiB) was recommended Vulkan and ran at
 ~9 tok/s — slower than plain CPU. `getSystemInfo()` already exposes
 `gpu.vendor` + `gpu.vulkan_info.device_type` (`IntegratedGpu`/`DiscreteGpu`,
 serialized via `format!("{:?}", …)` in `tauri-plugin-hardware`).
- **Decision (three minimal, independent fixes at the points the explore pass
 identified; no Rust IPC-shape change beyond the additive `proxy` param, no
 `get_supported_features` Vulkan-gate change):**
 1. **Fix A — proxy propagation + diagnostics.** New `ProxyEnv` struct
 (`{ url, username?, password?, no_proxy? }`) + `apply_proxy_env(&mut Command,
 &ProxyEnv)` helper in
 [`commands.rs`](src-tauri/src/core/system/commands.rs) sets
 `HTTP_PROXY`/`HTTPS_PROXY`/`ALL_PROXY` (+ lowercase twins) and `NO_PROXY`
 (always including `localhost,127.0.0.1,::1`), injecting basic-auth into the
 URL when creds are present. `install_agent` and `open_agent_terminal`
 (Windows `cmd /K`, macOS, Linux emulators) take `proxy: Option<ProxyEnv>`
 and apply it before spawn. `install_agent` captures installer output and,
 on a network signature (`output_indicates_network_failure`), returns an
 actionable error pointing at Settings → HTTPS Proxy and noting SOCKS often
 fails for npm/PowerShell installers. Frontend
 ([`launch/index.tsx`](web-app/src/routes/launch/index.tsx)) reads
 [`useProxyConfig`](web-app/src/hooks/useProxyConfig.ts), passes the payload
 to both commands (only when `proxyEnabled && proxyUrl`), and shows a
 localized `installFailedNetworkDesc` hint on detected network failures
 (EN + new RU `launch.json`; others fall back to EN).
 2. **Fix B — Windows runtime PATH refresh.** `#[cfg(windows)]
 refresh_windows_path()` re-reads `HKCU\Environment` + `HKLM\…\Session
 Manager\Environment` PATH (the same registry surface `add_to_path_windows`
 writes), merges with the live process PATH, dedupes; `apply_runtime_path`
 (no-op off Windows) applies it to a `Command`. Called in
 `detect_on_native_path` and `install_agent`, so a freshly-installed npm is
 found without an app restart; the prereq-missing message now suggests
 installing Node.js from nodejs.org and restarting.
 3. **Fix C — integrated-only iGPU guard.** In `detectIdealBackendType` of
 both [`llamacpp-upstream-extension`](extensions/llamacpp-upstream-extension/src/index.ts)
 and [`llamacpp-extension`](extensions/llamacpp-extension/src/index.ts):
 `hasDiscreteGpu = gpus.some(g => g.vulkan_info?.device_type ===
 'DiscreteGpu' || !!g.nvidia_info)` and `integratedGpuOnly = !hasDiscreteGpu
 && gpus.length > 0 && gpus.every(g => g.vulkan_info?.device_type ===
 'IntegratedGpu')`. The Vulkan tier (Windows + Linux) and the `gpuCapable`
 check now require `!integratedGpuOnly`, so an iGPU-only host falls through
 to `cpu-optimal`. CUDA tiers (discrete NVIDIA) unaffected; macOS unaffected
 (early return); Vulkan stays manually installable in Settings → Providers.
- **Consequences:** Behind-a-proxy installs propagate the proxy and, when they
 still fail, give an actionable region-block/SOCKS hint; npm installed
 mid-session is detected without restart; integrated-only laptops are
 recommended the CPU build instead of slow Vulkan. **Deliberately NOT done
 (out of scope):** making SOCKS work for npm/PowerShell (protocol limitation
 — covered by messaging), changing the Rust Vulkan feature gate (would hide
 Vulkan from the catalog), and any `jan*` rename. **Verified:** `cargo check
 -p Atomic-Chat` clean (pre-existing dead_code warnings only); both extension
 rolldown builds clean (`dist/index.js` 243.92 kB upstream / 197.34 kB
 turboquant — the authoritative compile); `eslint` clean on `launch/index.tsx`;
 both `launch.json` locales parse; language-server diagnostics clean on the
 three touched TS files. The project-wide web-app `tsc -b` currently halts on
 a **pre-existing, unrelated** `TS6133 getProviderByName declared but never
 read` in `web-app/src/containers/DownloadButton.tsx` (another in-progress
 uncommitted change merging the `llamacpp`/`llamacpp-upstream` provider model
 lists), not touched here. Manual Windows smoke (proxy-on install, mid-session
 npm detection, iGPU-only → `win-cpu-x64`) is the residual step (no such host
 in the sandbox).
- **Owner:** team.
- **Links:** the 2026-06-04 ADR *Resolve the login-shell PATH for Launch-page
 agent detection/install*, the 2026-06-15 ADR *Detect Launch-page agents
 installed inside WSL …*, the 2026-06-01 ADR *Add a "Launch" page …*, the
 2026-05-28 ADR *Linux ships only `llamacpp-upstream` … Vulkan is the sole GPU
 path*, files:
 [`src-tauri/src/core/system/commands.rs`](src-tauri/src/core/system/commands.rs)
 (`ProxyEnv`, `apply_proxy_env`, `output_indicates_network_failure`,
 `refresh_windows_path`, `apply_runtime_path`, `install_agent`,
 `open_agent_terminal`, `detect_on_native_path`),
 [`web-app/src/routes/launch/index.tsx`](web-app/src/routes/launch/index.tsx)
 (`buildProxyPayload`, network-failure toast),
 [`web-app/src/locales/en/launch.json`](web-app/src/locales/en/launch.json),
 [`web-app/src/locales/ru/launch.json`](web-app/src/locales/ru/launch.json),
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts)
 (`detectIdealBackendType` iGPU guard),
 [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts)
 (same guard).

---
