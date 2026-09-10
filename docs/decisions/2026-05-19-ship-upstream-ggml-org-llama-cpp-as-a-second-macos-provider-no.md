---
date: 2026-05-19
title: "Ship upstream `ggml-org/llama.cpp` as a second macOS provider, no fork"
---

# 2026-05-19 — Ship upstream `ggml-org/llama.cpp` as a second macOS provider, no fork

- **Context:** Some users prefer (or need) the vanilla upstream
 `ggml-org/llama.cpp` build on macOS — for compatibility testing, parity
 with other tools, or to avoid TurboQuant-specific behavior. Maintaining
 our own macOS fork of upstream just to re-publish identical binaries
 would be pure overhead.
- **Decision:** Bundle the **official `ggml-org/llama.cpp`** macOS release
 alongside our `AtomicBot-ai/atomic-llama-cpp-turboquant` fork in the same
 DMG, surface it in the UI as a separate provider named **"Llama.cpp"**.
 We do **not** fork upstream. We pull the official macOS release tarballs
 (`llama-bXXXX-bin-macos-arm64.tar.gz` / `-macos-x64.tar.gz`) and
 **re-codesign** every Mach-O with our Developer ID + hardened runtime +
 timestamp so the binaries survive notarization inside our `.app`.
- **Consequences:**
 - macOS users now see two `llama.cpp`-family providers:
   - "Llama.cpp + TurboQuant" — `extensions/llamacpp-extension/` driving
     the turboquant fork (`resources/llamacpp-backend/`).
   - "Llama.cpp" — `extensions/llamacpp-upstream-extension/` driving the
     upstream build (`resources/llamacpp-backend-upstream/`).
 - The new pipeline is wired through `make download-llamacpp-upstream-backend`
   (called from `dev*` targets and the macOS CI job
   `build-macos > "Download upstream llama.cpp backend"`).
 - A sibling Rust plugin `tauri-plugin-llamacpp-upstream` (capability
   `llamacpp-upstream:default`) was created by copying
   `tauri-plugin-llamacpp` and switching the bundle root. `args.rs` keeps
   its `is_turboquant()` gate, so vanilla version strings fall back to
   `q8_0` KV automatically — no flag stripping required.
 - DMG size grows by ~40–60 MiB. We accept this in exchange for
   offline-ready, single-click provider switching.
 - Windows / Linux are **not** affected — their pipelines stay on the
   turboquant fork (Linux/macOS-Intel/macOS-arm64) and `janhq/llama.cpp`
   mirror (Windows) respectively.
 - Cost: a parallel Rust plugin and TS extension. Mostly mechanical copies
   — a future cleanup may collapse them behind a vendor-aware plugin.
 - **Local API Server proxy is dual-state aware.** The proxy at
   `http://localhost:1337/v1` (see `src-tauri/src/core/server/proxy.rs`
   and `core/server/commands.rs`) takes session-pool handles from both
   `tauri_plugin_llamacpp::state::LlamacppState` (turboquant) and
   `tauri_plugin_llamacpp_upstream::state::LlamacppState` (upstream).
   Model lookup tries turboquant first, then upstream, then MLX, and
   tags `state.backend` with `"llamacpp" | "llamacpp-upstream" | "mlx"`
   accordingly. `/v1/models` lists models from all three pools,
   `/v1/metrics` resolves the right `llama-server` for either llama.cpp
   variant, and the auto-increase-ctx retry path treats
   `llamacpp-upstream` symmetrically with `llamacpp`. The upstream
   extension only listens to `local_backend://auto_increase_ctx` events
   whose `backend === 'llamacpp-upstream'`, so ownership is unambiguous.
 - **Shared GGUF tree, isolated engines.** Both providers store and read
   models from the same on-disk tree at `<jan>/llamacpp/models/<modelId>/`
   (constant `MODELS_PROVIDER_ROOT = 'llamacpp'` in the upstream
   extension). A single download serves both engines. Backend binaries
   and per-provider settings stay isolated under each provider's own
   folder: `<jan>/llamacpp/backends/` for turboquant and
   `<jan>/llamacpp-upstream/backends/` for upstream. Each provider's
   Models tab in the UI shows the same model list but reports
   `Running` (and exposes Start/Stop) only for sessions owned by **its
   own** plugin state, because each plugin holds an independent
   `LlamacppState` pool and queries it via its own
   `plugin:llamacpp|*` or `plugin:llamacpp-upstream|*` IPC namespace.
   This means a single model can be running on both engines
   simultaneously on different ports — fine, both processes mmap the
   same GGUF read-only.
 - **Upstream backend updates ship only with Atomic Chat releases.**
   *(This clause was superseded on 2026-08-12 — see the note at the end of
   this record.)*
   `extensions/llamacpp-upstream-extension/src/backend.ts::fetchRemoteBackends`
   returns `[]` unconditionally, mirroring the turboquant extension's
   macOS behavior. The Atomic Chat installer ships exactly one
   `llama-server` build per release — the one fetched and re-codesigned
   by `make download-llamacpp-upstream-backend` against
   `https://api.github.com/repos/ggml-org/llama.cpp/releases/latest`
   at build time. The provider settings dropdown therefore only lists
   the bundled backend plus any backends the user installed locally;
   no runtime GitHub polling, no silent in-place upgrades, no
   rate-limit surprises. Re-enabling runtime fetching is a deliberate
   future ADR change, not an opportunistic one.
- **Owner:** team.
- **Links:** `Makefile` (`download-llamacpp-upstream-backend`),
 `src-tauri/plugins/tauri-plugin-llamacpp-upstream/`,
 `extensions/llamacpp-upstream-extension/`,
 [ggml-org/llama.cpp](https://github.com/ggml-org/llama.cpp).

<!--
Superseded in part by 2026-08-12-update-upstream-llama-cpp-at-runtime-on-macos-too.md:
only the "Upstream backend updates ship only with Atomic Chat releases" clause.
macOS reads the atomic-chat-conf manifest at runtime, and a downloaded build is
gated on a `llama-server --version` smoke test. The bundled build is still
re-codesigned with our Developer ID, which notarization requires; it now resolves
its tag from the manifest rather than the GitHub API. Everything else here stands.
-->

