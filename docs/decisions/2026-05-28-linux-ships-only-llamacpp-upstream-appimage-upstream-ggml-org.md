---
date: 2026-05-28
title: "Linux ships only `llamacpp-upstream` (AppImage, upstream `ggml-org/llama.cpp`); Vulkan is the sole GPU path"
---

# 2026-05-28 — Linux ships only `llamacpp-upstream` (AppImage, upstream `ggml-org/llama.cpp`); Vulkan is the sole GPU path

- **Context:** Atomic Chat had no Linux release channel at all — the only
 supported targets were macOS (Universal) and Windows x64. The "Linux
 support" epic (Daniel, 2026-05-26) calls for closing that gap in two
 phases: Phase 1 is the mainstream `linux-x86_64` build for ordinary
 desktops, Phase 2 (deferred to a separate epic) targets `linux-aarch64`
 + NVIDIA DGX Spark (GB10, `sm_121`). The current repo already had a
 partial Linux scaffolding — `src-tauri/tauri.linux.conf.json` listed
 `["deb", "appimage"]` bundle targets, `package.json :: build:tauri:linux`
 plus the helper scripts `src-tauri/build-utils/buildAppImage.sh`
 (hardcoded `Jan.AppDir` / `appimagetool-x86_64.AppImage`) and
 `src-tauri/build-utils/shim-linuxdeploy.sh`, and `scripts/download-bin.mjs`
 already knew how to fetch `bun` / `uv` for both `x86_64-unknown-linux-gnu`
 and `aarch64-unknown-linux-gnu`. The legacy `flatpak/ai.jan.Jan.yml`
 metadata was also still present. What was missing: any CI job, any
 llama.cpp binary fetch path, any Linux entry in the upstream backend
 matrix, and any `latest.json` platform key.

 Two facts about the upstream `ggml-org/llama.cpp` release stream
 forced the shape of this decision. (1) On the `b9371`
 reference snapshot taken while planning this work, the Linux
 archive set is exactly: `ubuntu-x64.tar.gz`, `ubuntu-arm64.tar.gz`,
 `ubuntu-s390x.tar.gz`, `ubuntu-vulkan-x64.tar.gz`,
 `ubuntu-vulkan-arm64.tar.gz`, `ubuntu-rocm-7.2-x64.tar.gz`,
 `ubuntu-openvino-2026.0-x64.tar.gz`. (2) **There is no
 `ubuntu-cuda-*` asset of any architecture on the upstream release
 stream** — CUDA is published only as `win-cuda-12.4-x64.zip` and
 `win-cuda-13.3-x64.zip`. The original epic text assumed a
 `linux-x64-cuda` binary would just be there; it is not.

- **Decision:** Phase 1 is Linux/x86_64 only, AppImage only, upstream
 only, with Vulkan as the sole GPU path. Concretely:

 1. **One package format: AppImage.** `src-tauri/tauri.linux.conf.json`
 `bundle.targets` is narrowed from `["deb", "appimage"]` to
 `["appimage"]`. We do not ship `.deb`, `.rpm`, Snap, or Flatpak.
 Rationale: a single artefact yields one updater path
 (Tauri-signed AppImage), works on every mainstream distro
 (Ubuntu 22.04+, Debian 12+, Fedora 40+, Arch, openSUSE, Mint,
 Pop!_OS, etc.), and avoids per-distro packaging tax until we
 have actual user demand. Native `apt` integration for the
 Debian / Ubuntu cohort is recognised as a follow-up trade-off
 we are accepting against the maintenance burden of multiple
 release channels.
 2. **One backend provider: `llamacpp-upstream`.** Linux drives
 `extensions/llamacpp-upstream-extension/` +
 `src-tauri/plugins/tauri-plugin-llamacpp-upstream/` exactly the
 way Windows does after the 2026-05-22 ADR
 *Windows ships only `llamacpp-upstream`*. The turboquant
 `@janhq/llamacpp-extension` is excluded from
 `package.json :: build:extensions:linux` so only one provider
 ships. This **supersedes** the Linux clause of the 2026-05-19
 ADR *Use `AtomicBot-ai/atomic-llama-cpp-turboquant` as the LLM
 backend* and the §4.2 platform table line
 *"Linux (CUDA / Vulkan / HIP / CPU) — our fork
 `atomic-llama-cpp-turboquant`"*. Both lose the Linux row to
 this entry; macOS and Windows are unchanged.
 3. **Vulkan is the only GPU path on Linux.** Because upstream
 publishes no `ubuntu-cuda-*` asset, NVIDIA, AMD, and Intel
 users all share the single `linux-vulkan-x64` build. We
 explicitly do **not** ship ROCm 7.2 or OpenVINO 2026.0
 builds in Phase 1 — both are upstream-available
 (`ubuntu-rocm-7.2-x64.tar.gz`, `ubuntu-openvino-2026.0-x64.tar.gz`)
 and can be added later behind a hardware-gated whitelist
 entry in `fetchRemoteBackends` + `get_supported_features`,
 but they are out of scope today.
 4. **Bundled-by-default: `linux-cpu-x64`.** Mirrors the Windows
 ADR — the installer ships exactly one llama-server build
 (the CPU one), so Atomic Chat is usable offline on first
 launch on any Linux box without a working GPU stack. The
 hardware-gated picker (`detectIdealBackendType`) auto-suggests
 `linux-vulkan-x64` when `tauri-plugin-hardware` reports a
 working Vulkan loader and at least one GPU. The user can
 also install it manually from Settings → Providers →
 Llama.cpp → Find optimal backend.
 5. **Backend id naming.** The Rust matrix in
 `tauri-plugin-llamacpp-upstream/src/backend.rs` ::
 `determine_supported_backends` is rewritten for the
 `linux-x86_64` arm to emit `linux-cpu-x64` and (conditionally)
 `linux-vulkan-x64`. The legacy janhq-mirror ids previously
 hard-coded in that file (`linux-common_cpus-x64`,
 `linux-cuda-{11,12,13}-common_cpus-x64`,
 `linux-vulkan-common_cpus-x64`) are removed from the matrix
 but kept addressable through `map_old_backend_to_new`, which
 maps every persisted legacy id to its closest current
 equivalent (`linux-vulkan-*` → `linux-vulkan-x64`, anything
 else including the dropped Linux CUDA tiers →
 `linux-cpu-x64`). The TS-side
 `extensions/llamacpp-upstream-extension/src/backend.ts` ::
 `fetchRemoteBackends` gets a `linux` branch with a whitelist
 of `linux-cpu-x64` and `linux-vulkan-x64`, translating
 upstream's `ubuntu-{x64,vulkan-x64}` asset names into the
 internal `linux-*` ids; `getBackendDownloadUrl` handles the
 reverse mapping plus the `.tar.gz` extension upstream uses
 on Linux (vs `.zip` on Windows / macOS).
 6. **`Makefile` Linux branch.** `download-llamacpp-upstream-backend`
 grows an `else ifeq ($(shell uname -s),Linux)` arm that
 reuses the existing `_gh_get` / `_gh_fetch` retry helpers
 from the Windows branch to pull
 `llama-${TAG}-bin-ubuntu-x64.tar.gz` into
 `src-tauri/resources/llamacpp-backend-upstream/`,
 normalising the layout into `build/bin/` to match the
 Windows / macOS conventions. `download-llamacpp-upstream-backend-if-exists`
 gets the matching Linux branch. A convenience target
 `download-llamacpp-upstream-backend-linux-cpu` is added for
 CI to invoke explicitly, mirroring
 `download-llamacpp-upstream-backend-win-cpu`.
 7. **CI: `build-linux-x64` job on `ubuntu-22.04`.**
 `.github/workflows/release.yml` gains a third platform job
 next to `build-macos` / `build-windows`. The runner is
 pinned to `ubuntu-22.04` (glibc 2.35) so the AppImage stays
 compatible with the widest possible distro range (Ubuntu
 24.04 / Debian 12 / Fedora 40 / etc. all ship glibc ≥ 2.35).
 The job installs the WebKitGTK 4.1 + Tauri AppImage system
 deps, downloads the Linux upstream backend, builds web /
 core / extensions (with the new exclusion), builds the
 `jan-cli` Linux binary, and runs `yarn build:tauri:linux`
 which already chains `shim-linuxdeploy.sh` + `tauri build` +
 `buildAppImage.sh`. The collected artefacts are the
 `*.AppImage` and its companion `.AppImage.sig` (Tauri
 updater signature).
 8. **`latest.json` gets a `linux-x86_64` block.**
 `src-tauri/latest.json.template` adds the new platform key,
 and `publish-latest-json` in `release.yml` extends its `jq`
 pipeline to populate or `del()` the block based on whether
 `build-linux-x64.result == 'success'`, mirroring the
 existing handling for `darwin-*` and `windows-x86_64`. The
 Tauri updater now serves Linux clients on the same channel
 as macOS / Windows.
 9. **Rename collateral.** `tauri.linux.conf.json` title flips
 from `"Jan"` to `"Atomic Chat"`. `buildAppImage.sh` flips
 its hardcoded `Jan.AppDir` / `usr/lib/Jan/binaries` paths
 to the matching `Atomic Chat` paths produced by the new
 product name. `web-app/src/lib/utils.ts`'s `LOCAL_LLAMACPP_PROVIDER`
 / `LOCAL_LLAMACPP_EXTENSION_NAME` switches from
 `IS_WINDOWS ? upstream : turboquant` to
 `IS_WINDOWS || IS_LINUX ? upstream : turboquant` so the UI
 routes to the right provider id on Linux without forking
 dozens of call sites.

- **Consequences:**
 - **Linux x86_64 release channel exists.** Every tagged release
 publishes `Atomic-Chat_x.y.z_amd64.AppImage` + `.sig` and a
 `linux-x86_64` entry in `latest.json`. Linux users get the
 same auto-update flow as macOS / Windows users.
 - **One UI experience across all desktops.** Linux users see the
 same single "Llama.cpp" provider that Windows users see
 (per the 2026-05-22 ADR). macOS keeps its dual-provider
 layout (turboquant + upstream side-by-side) — that is a
 macOS-only thing.
 - **NVIDIA-on-Linux performance ceiling.** Without `ubuntu-cuda-*`
 upstream artefacts, NVIDIA users on Linux take a Vulkan
 backend — historically ~10–20 % slower decode than CUDA on
 the same card. Acceptable for Phase 1 (the alternative is
 building and signing a CUDA-Linux binary ourselves, which is
 deferred to a follow-up epic). The README "Running on Linux"
 section will state this trade-off plainly so users with
 high perf requirements know to wait for the CUDA-Linux work
 or run the turboquant fork manually.
 - **No TurboQuant / MTP / NextN on Linux.** All three depend on
 our fork and are not in upstream. Linux users do not see
 those options in the UI. Re-enabling them is the explicit
 subject of a future ADR (it requires (a) qualifying the
 turboquant fork against Linux/x86_64 CUDA + Linux/x86_64
 Metal-equivalent backends, (b) shipping a second `llamacpp`
 provider on Linux like macOS does).
 - **DGX Spark / aarch64 deferred.** Phase 2 of the Linux epic
 stays open. The decision **not** to ship aarch64 in Phase 1
 is a hard prerequisite — we want stable x86_64 packaging
 + CI infrastructure before splitting the matrix again.
 Phase 2 will produce a separate ADR covering the aarch64
 build, the AppImage tooling story
 (`appimagetool-aarch64.AppImage`,
 `linuxdeploy-aarch64.AppImage`), the DGX Spark backend
 choice (Vulkan on GB10 vs. building a CUDA-`sm_121` binary
 ourselves), and the test-hardware plan.
  - **Legacy `flatpak/` files deleted.** The `flatpak/ai.jan.Jan.yml`
 manifest, its `flathub.json` / `ai.jan.Jan.metainfo.xml`
 siblings, and `flatpak/patches/fix-cstdint.patch` were
 archaeology from the janhq fork and carried the wrong
 identifier (`ai.jan.Jan` vs. our `chat.atomic.app`). They
 were removed in this epic. If we ever decide to ship a
 Flatpak in the future, we will write a fresh manifest under
 the current identifier and address the genuinely-hard parts
 separately — Flathub's "no runtime executable downloads"
 rule conflicts with our sidecar-download model
 (`@janhq/download-extension` fetches backend binaries at
 runtime), CUDA / Vulkan need either `--filesystem=host` or a
 dedicated Flatpak extension, and the local `localhost:1337`
 OpenAI-compat surface needs explicit portal config for the
 third-party tools that consume it (OpenCode, OpenClaude,
 Hermes Workspace, nanoclaw). Deferring Flatpak past Phase 1
 keeps the maintenance surface focused.
 - **`s390x`, `rocm-7.2-x64`, `openvino-2026.0-x64` upstream
 assets ignored.** The TS asset whitelist explicitly drops
 them; the Rust matrix does not enumerate them. Adding any
 of the three is a one-line whitelist edit plus a feature
 detector in `get_supported_features` — no architectural
 blocker, just out of scope today.
 - **`map_old_backend_to_new` rescues persisted settings.**
 Linux users who used a pre-2026-05-28 dev build with the
 turboquant `linux-cuda-*` / `linux-vulkan-common_cpus-x64`
 ids in their settings get auto-mapped onto the new
 `linux-cpu-x64` / `linux-vulkan-x64` ids on next start —
 no manual intervention required.
 - **Test coverage.** New unit tests in
 `tauri-plugin-llamacpp-upstream` lock down the Linux matrix
 (cpu-only, cpu + vulkan, vulkan-without-cpu impossible) and
 every legacy-id mapping path. Existing macOS / Windows
 tests are unchanged and still pass.
 - **Smoke-test plan.** Phase-1 acceptance requires (a) a clean
 Ubuntu 24.04 x86_64 VM run (no GPU) — AppImage downloads,
 launches under WebKitGTK 4.1, loads Qwen3 0.6B Q8 on the
 bundled CPU backend, answers via `http://localhost:1337/v1`;
 (b) an Ubuntu 22.04 + NVIDIA GPU host run — same as (a) plus
 "Find optimal backend" installs `linux-vulkan-x64` and the
 GPU is actually used. Both verifications run before the
 first tagged Linux release.

- **Owner:** team.
- **Links:** §4.2 *LLM backend*, the 2026-05-22 ADR
 *Windows ships only `llamacpp-upstream`*, the 2026-05-19 ADRs
 *Use `AtomicBot-ai/atomic-llama-cpp-turboquant` as the LLM backend*
 and *Ship upstream `ggml-org/llama.cpp` as a second macOS provider*,
 the "Linux support for Atomic Chat" epic (Daniel, 2026-05-26),
 [ggml-org/llama.cpp releases](https://github.com/ggml-org/llama.cpp/releases),
 files: [`src-tauri/tauri.linux.conf.json`](src-tauri/tauri.linux.conf.json),
 [`src-tauri/build-utils/buildAppImage.sh`](src-tauri/build-utils/buildAppImage.sh),
 [`src-tauri/build-utils/shim-linuxdeploy.sh`](src-tauri/build-utils/shim-linuxdeploy.sh),
 [`src-tauri/latest.json.template`](src-tauri/latest.json.template),
 [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs),
 [`extensions/llamacpp-upstream-extension/src/backend.ts`](extensions/llamacpp-upstream-extension/src/backend.ts),
 [`package.json`](package.json) (`build:extensions:linux`),
 [`Makefile`](Makefile) (`download-llamacpp-upstream-backend` Linux branch),
 [`.github/workflows/release.yml`](.github/workflows/release.yml)
 (`build-linux-x64` job),
 [`web-app/src/lib/utils.ts`](web-app/src/lib/utils.ts)
 (`LOCAL_LLAMACPP_PROVIDER`).
