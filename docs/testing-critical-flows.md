# Critical-flow test evidence

This document records what the local test system proves about Atomic Chat. It
is an evidence map, not a test-count dashboard. Update it when a production
entrypoint, backend contract, or owning test changes.

## Evidence grades

- **Strong** — exercises the production entrypoint, asserts an observable
  outcome, covers at least one failure path, and crosses the important layer
  boundary.
- **Partial** — proves one or more stages but replaces another load-bearing
  stage with a mock or does not assert the final outcome.
- **Smoke** — proves construction, rendering, registration, or invocation only.
- **Missing** — no test executes the production path.

Line coverage cannot raise a grade by itself.

## Current critical flows

### Hardware to backend to release asset — partial, P0

Production entrypoints:

- `tauri-plugin-hardware` reports OS, architecture, GPUs, drivers, CUDA, and
  Vulkan capabilities.
- Both llama.cpp plugins map those facts through provider-specific
  `get_supported_features`, `determine_supported_backends`, and
  `prioritize_backends` paths.
- Both llama.cpp extensions filter their provider manifest and map internal
  backend ids to exact archive URLs.
- `web-app/src/lib/utils.ts` selects the product-default provider.

Existing evidence:

- Rust table cases cover Windows CUDA driver boundaries, Windows backend ids,
  macOS architecture, Linux CPU/Vulkan, ignored Linux CUDA flags, and the
  unsupported Linux ARM placeholder.
- `prioritize_backends` tests prove newest CUDA 13 selection, Linux Vulkan
  memory fallback, and empty-catalog rejection.
- Extension tests cover the upstream manifest parser, Windows whitelist,
  Linux CPU/Vulkan whitelist, archive naming, the pinned offline baseline, and
  hardware recommendations for Windows CUDA and Linux Vulkan/CPU.
- Windows and Linux package both providers. Upstream remains the default;
  TurboQuant keeps separate ids, assets, driver gates, and storage.
- `models.windowsProviderRouting.test.ts` checks frontend routing on Windows.
- `tests/fixtures/hardware/profiles.json` is consumed by deterministic contract
  tests for Windows CUDA 13, Linux NVIDIA Vulkan, integrated Vulkan fallback,
  and Apple Silicon. The contract pins provider-specific ids and verifies that
  selected backends resolve to published manifest assets.
- The TurboQuant extension now covers remote-manifest transport fallback and
  hardware recommendation parity with upstream.

Gap:

- The shared profile fixture does not yet drive both Rust feature detection and
  TypeScript asset selection in one cross-language test.
- macOS Intel has no published TurboQuant tag in the current fork release
  catalog. The build now skips that pairing, but there is no executable test
  for the build-time branch.

### Versioned llama.cpp and MLX compatibility — partial, P0

Production entrypoints:

- `tauri-plugin-llamacpp/src/args.rs` builds the TurboQuant process arguments.
- `tauri-plugin-llamacpp-upstream/src/args.rs` builds upstream process
  arguments and gates newer speculative features by build capability.
- `extensions/mlx-extension/src/index.ts` translates settings into `MlxConfig`.
- `tauri-plugin-mlx/src/commands.rs` translates `MlxConfig` into the
  `mlx-server` process and readiness lifecycle.
- `src-tauri/src/core/server/proxy.rs` exposes the local OpenAI-compatible
  facade.

Verified local artifacts:

- TurboQuant `b10269-1.4.0` reports build `10679`, commit `074bf826e`. Its
  cache types include `turbo2`, `turbo3`, and `turbo4`.
- Upstream `b10205` reports build `10205`, commit `1e2259952`. Its cache types do
  not include TurboQuant values.
- Both llama binaries advertise `draft-mtp` and `draft-dflash` speculative
  modes; backend-specific cache types remain distinct.
- MLX `mlxvlm-macos-arm64-addaf9f` advertises
  `--draft-kind dflash|eagle3|mtp`,
  `--kv-quant-scheme uniform|turboquant`, floating-point `--kv-bits`,
  `--max-kv-size`, and `--draft-block-size`.

Existing evidence:

- Both llama argument builders have broad unit coverage, including cache-type
  fallback and build-gated speculative flags.
- The upstream builder rejects TurboQuant-only cache types even if stale
  configuration carries a TurboQuant-shaped version string.
- Exact verified tags are pinned for macOS TurboQuant, upstream llama.cpp, and
  MLX. Windows/Linux TurboQuant resolve exact per-backend tags from an immutable
  `atomic-chat-conf` revision rather than the moving `main` branch.
- A moving upstream manifest is rejected until a compatibility update changes
  the pin and its tests together.
- MLX tests cover settings-to-`MlxConfig` normalization and final Rust argv for
  context, model-path normalization, DFlash/MTP/EAGLE-3, and complete KV
  quantization pairs.
- MLX registry, vision classification, and context-growth helpers are tested.
- MLX early validation tests distinguish missing binary from missing model
  without waiting for the process-session lock.
- Pinned capability snapshots cover TurboQuant, upstream llama.cpp, and MLX.
  Every long flag emitted by each Rust builder must exist in its provider's
  snapshot; `make capture-capabilities` refreshes snapshots explicitly.
- `make test-live` can launch configured local sidecars on loopback and verify
  readiness, model listing, completion, SSE ordering, cancellation recovery,
  optional tool calls, bad model paths, and sanitized cassette output.

Gap:

- The TS and Rust halves of the MLX configuration contract are tested
  separately; no one test crosses the language/IPC boundary.
- The extension has no `performLoad` contract test.
- Windows/Linux TurboQuant binaries still need platform-native `--help` and
  process acceptance before advancing the pinned manifest revision.
- Live sidecar acceptance is opt-in and still needs platform-native execution
  before advancing a binary pin.
- `mlx-server/Sources/MLXServer` is legacy Swift source; release builds download
  the PyInstaller binary from `AtomicBot-ai/mlx-vlm`.

### Onboarding — partial, P0

Production entrypoints:

- `web-app/src/containers/SetupScreen.tsx`
- `web-app/src/containers/SetupBackendStep.tsx`
- `web-app/src/hooks/useModelProvider.ts`

`SetupScreen.test.tsx` now renders the production component and verifies the
post-discovery onboarding UI plus persisted skip completion. Backend
recommendation, failed download recovery, provider selection, and the
transition into the main application remain unproved as one flow.

### Hub model install and start — partial, P0

Production entrypoints:

- `web-app/src/routes/hub/index.tsx`
- `web-app/src/routes/hub/$modelId.tsx`
- `web-app/src/services/models/default.ts`
- `web-app/src/lib/model-factory.ts`

`DefaultModelsService` tests assert catalog fallback, pull, abort, delete,
start, stop, already-loaded behavior, and engine errors. Model-factory tests
cover model conversion. No test drives the Hub route through download progress,
metadata persistence, backend selection, and a model-ready result.

### Chat send, stream, render — partial, P0

Production entrypoints:

- `web-app/src/routes/threads/$threadId.tsx`
- `web-app/src/lib/custom-chat-transport.ts`
- `web-app/src/hooks/useMessages.ts`
- `web-app/src/containers/RenderMarkdown.tsx`

Message-store persistence and markdown rendering have isolated tests. A
production `CustomChatTransport` harness now verifies ordered deltas, leaked
MLX-token filtering, and malformed streamed tool-input repair. Pure contracts
cover Anthropic serial tool waves, disabled-tool filtering, llama template
overrides, MCP/RAG execution, output continuation, and cancellation. No test
yet starts from user submit and proves final assistant persistence plus an
error outcome.

### Thread persistence and reload — strong below the UI

Production entrypoints:

- `web-app/src/hooks/useThreads.ts`
- `src-tauri/src/core/threads/commands.rs`
- `src-tauri/src/core/threads/file_store.rs`
- `src-tauri/src/core/threads/ipc_tests.rs`

Rust CRUD tests execute the file-backed store, and Tauri IPC tests cover the
thread/message/assistant commands through the registered invoke boundary.
Frontend store tests cover local state and service invocation. The remaining
gap is a desktop restart journey proving that the UI rehydrates the same thread.

### Local OpenAI-compatible API on port 1337 — partial

Production entrypoints:

- `src-tauri/src/core/server/mod.rs`
- `src-tauri/src/core/server/proxy.rs`
- `src-tauri/src/core/server/responses_shim.rs`
- `web-app/src/hooks/useLocalApiServer.ts`

Rust tests cover route allowlists, authentication, model-id normalization,
proxy transformations, and Responses API translation. The frontend hook tests
cover state transitions. There is no real socket round-trip through the local
server to a deterministic backend stub.

### Agent turn and approval — strong at the deterministic runtime boundary

Production entrypoints:

- `src-tauri/src/core/agent/runner.rs`
- `src-tauri/src/core/agent/approval.rs`
- `src-tauri/src/core/agent/commands.rs`
- `web-app/src/hooks/useAgentRun.ts`

The Rust suite covers the runner loop, grammar, batches, tools, approvals,
loop guards, sessions, path policy, and failure behavior with deterministic
LLM/tool doubles. Frontend hooks cover event reduction and cancellation. A real
model run is intentionally ignored and is not part of `test-local`; this does
not weaken the deterministic runtime contract but leaves model acceptance as a
manual or separately gated concern.

### Launch integrations — partial

Production entrypoints:

- `web-app/src/routes/launch/`
- `web-app/src/constants/integrations.ts`
- `src-tauri/src/core/system/commands.rs`

The integration catalog and platform commands are present, but the system
command module has almost no behavioral test coverage relative to its size.
There is no isolated-HOME scenario proving install detection, generated config,
idempotency, and preservation of unrelated user configuration.

### Data-folder migration and reset — partial

Production entrypoints:

- `web-app/src/services/app/tauri.ts`
- `src-tauri/src/core/app/commands.rs`
- `src-tauri/src/core/filesystem/`

Frontend adapter tests prove IPC command names and argument shapes. Rust
filesystem tests prove lower-level operations. No contract test proves a
successful relocation plus rollback on failure while preserving user data.

### Sidecar and plugin lifecycle — partial

Production entrypoints:

- `src-tauri/src/core/extensions/commands.rs`
- `src-tauri/src/core/process_reaper.rs`
- llama.cpp and MLX plugin process/session modules

There are focused process, unload, and error-path tests, but no deterministic
scenario proves start, readiness, routing, cancellation, unload, and orphan
cleanup as one lifecycle.

## Coverage snapshot

Commands run on 2026-07-29:

```text
yarn test:coverage
yarn --cwd extensions workspace @janhq/llamacpp-extension test:coverage
yarn --cwd extensions workspace @janhq/llamacpp-upstream-extension test:coverage
node scripts/check-coverage-floor.mjs
```

Results:

- Root project set: 1,595 tests passed and 5 skipped; statements 26.03%,
  branches 68.79%, functions 46.20%.
- TurboQuant extension: 108 tests passed; statements 31.56%, branches 70.85%,
  functions 48.11%.
- Upstream extension: 167 tests passed; statements 33.06%, branches 67.34%,
  functions 51.72%.
- Critical-file floors include `custom-chat-transport.ts` at 65.60%
  statements, `SetupScreen.tsx` at 34.44%, TurboQuant `backend.ts` at 70.09%,
  and upstream `backend.ts` at 54.59%.

The low web-app statement figure is not itself a failure criterion. The
zero-execution and low-execution values above are used only to corroborate
specific critical-flow gaps.

## Known false-confidence signals

- `scripts/check-test-quality.mjs` rejects newly introduced mocked subjects,
  replacement `Mock*` components, call-only assertions, tautological
  expectations, duplicated production helpers, and broken evidence-map links.
- Existing debt is explicit in `tests/test-quality-allowlist.json`; deleting a
  violation requires deleting its allowlist entry.
- The former replacement tests for SetupScreen, ChatInput, DataProvider, and
  Hugging Face conversion now exercise production code.
- `serviceHub.integration.test.ts` primarily asserts constructor names and
  object existence; it proves branch wiring, not adapter behavior.
- Interaction-only assertions such as `toHaveBeenCalled()` are partial unless
  the same test also checks persisted or rendered outcome.
- Five core tests are skipped: one model-entity test and four obsolete engine
  mapping cases. They do not currently protect a critical production flow.

## Mutation pilot

Ten temporary Rust mutations were run one at a time in an isolated worktree
against the current suite. Eight were killed:

- Windows CPU asset selection;
- Linux Vulkan memory fallback;
- upstream rejection of TurboQuant cache types;
- TurboQuant acceptance of its own cache types;
- the CUDA 13 minimum-driver boundary;
- MLX unknown-drafter fallback;
- MLX complete KV quantization pairs;
- MLX loopback-only binding.

Two mutations initially survived:

- `ubuntu-vulkan-*` could map to CPU without failing a test;
- an MLX early validation error could change classification while the test
  asserted only generic failure.

Focused assertions were added for Ubuntu x64/arm64 Vulkan migration and for
distinct `BinaryNotFound` / `ModelFileNotFound` outcomes. The pilot score
records the suite as measured (**8/10, 80%**); the two observed survivors are
now regression-tested rather than retroactively rewriting the score.

## Prioritized gap register

### P0 — required evidence

1. Onboarding backend recommendation, failed-download recovery, and completion
   do not yet form one production flow.
2. Chat submit to streamed render, persistence, and error has no
   integrated test.
3. Hardware selection has no one cross-language Rust-to-TypeScript
   hardware-to-exact-asset scenario.
4. Backend process acceptance exists only as an opt-in live contract, not a
   deterministic default-gate sidecar lifecycle.
5. The local OpenAI-compatible API has no real socket round-trip to a
   deterministic backend stub.
6. Hub download/start and Launch-agent installation have no production route
   journey.
7. Data-folder relocation has no success-and-rollback behavioral test.

### P1 — important supporting evidence

1. UI thread rehydration after desktop restart is unproved despite strong Rust
   file-store and IPC coverage.
2. llama.cpp error classification and extension stream cancellation are thin.
3. Sidecar orphan cleanup is tested as matching logic, not as a lifecycle.
4. ServiceHub construction is smoke evidence; adapter behavior belongs to the
   dedicated `mockIPC` suites.

### P2 — cleanup

1. Remove or restore the five non-critical skipped core tests.
2. Rename smoke suites whose current names imply stronger integration evidence.
3. Replace tautological assertions such as `expect(true).toBe(true)` in
   critical-flow-adjacent tests.

## Scroll V WDIO acceptance contract

Scroll V is limited to WDIO desktop journeys. It must not compensate for weak
unit tests by reproducing every branch in UI automation. A scenario passes only
when it uses the packaged Tauri IPC boundary and asserts a user-visible or
externally observable outcome.

1. **Clean onboarding and backend recommendation**
   - start with an isolated empty data directory;
   - reach the production setup screen;
   - assert the provider/backend shown for the host fixture;
   - complete setup and prove the completion survives an app restart.
2. **Hub install, model start, and first streamed reply**
   - install a deterministic local fixture model/backend without public
     network access;
   - observe download progress and a model-ready state;
   - submit a message, observe ordered streamed text, and assert the final
     assistant message is persisted.
3. **Thread persistence across restart**
   - create a named thread with user and assistant content;
   - restart the desktop process against the same isolated data directory;
   - assert the same thread and content rehydrate in the UI.
4. **Local OpenAI-compatible API**
   - enable the local API in the UI;
   - issue an external request to the test port;
   - assert authentication failure, one successful `/v1/models` request, and
     one streamed `/v1/chat/completions` response.
5. **Launch integration**
   - use an isolated HOME;
   - configure one representative coding agent from the production Launch page;
   - assert the generated config points to the local API and preserves an
     unrelated pre-existing key;
   - repeat the action and prove idempotency.
6. **Data-folder relocation**
   - create a thread in an isolated original data directory;
   - relocate through the production settings UI;
   - restart and prove the thread loads from the new directory;
   - inject a copy failure in a separate fixture and prove the original remains
     authoritative.

WDIO scenarios must use deterministic local fixtures, retain screenshots and
logs on failure, and may not download model weights or contact GAIA.
