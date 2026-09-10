---
date: 2026-07-14
title: "Bundle every upstream Windows DLL, repair incomplete installs, and isolate provider backend preferences (ATO-294)"
---

# 2026-07-14 — Bundle every upstream Windows DLL, repair incomplete installs, and isolate provider backend preferences (ATO-294)

- **Context:** GitHub #175 reported `llama-server.exe` failing on relaunch
 because `llama-server-impl.dll` was absent from
 `resources/llamacpp-backend-upstream/build/bin`. The ggml-org Windows archive
 is flat, but the release workflow relocated only `*.exe` into `build/bin`;
 DLLs stayed at the resource root while `install_bundled_backend` copied only
 the `build/` tree into the user backend directory. Existing installs were
 then treated as valid because the upstream plugin checked only the executable
 and backend version. The TurboQuant and upstream extensions also shared the
 `llama_cpp_backend_type` localStorage key despite using incompatible clean
 backend ids (`windows-x64-vulkan` versus `win-vulkan-x64`), so either provider
 could overwrite the other's preference.
- **Decision:** Relocate every non-metadata top-level file from the flat
 upstream archive into `build/bin`, fail the Windows release job unless
 `llama-server-impl.dll` is present there, and mirror the TurboQuant plugin's
 recursive bundled-backend completeness check in
 `tauri-plugin-llamacpp-upstream`. When an installed backend has the expected
 executable/version but lacks any bundled file, copy the bundled `build/`
 tree over it in place. Store backend-type preferences under separate Atomic
 Chat keys for TurboQuant and upstream. On first read, migrate the legacy
 shared value only when its id shape belongs to that provider; leave the
 legacy key untouched so both extensions can independently inspect it.
- **Consequences:** New Windows installers contain the complete upstream
 runtime, and upgrades repair previously incomplete user backend directories
 without deleting models, settings, or the whole `llamacpp-upstream` tree.
 The repair can only restore files present in the new app bundle; users must
 install a fixed build first. Provider selections no longer overwrite one
 another or oscillate between incompatible id schemes. Verified by upstream
 plugin unit tests and provider-preference migration tests; a packaged Windows
 install/relaunch smoke test remains required.
- **Owner:** team.
- **Links:** [ATO-294](https://linear.app/atomicchat/issue/ATO-294),
 [GitHub #175](https://github.com/AtomicBot-ai/Atomic-Chat/issues/175),
 [`.github/workflows/release.yml`](.github/workflows/release.yml),
 [`src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs`](src-tauri/plugins/tauri-plugin-llamacpp-upstream/src/backend.rs),
 [`extensions/llamacpp-extension/src/index.ts`](extensions/llamacpp-extension/src/index.ts),
 [`extensions/llamacpp-upstream-extension/src/index.ts`](extensions/llamacpp-upstream-extension/src/index.ts).

---
