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

- `atomic-chat-core` `src/runtime/llamacpp/args.ts` builds the TurboQuant and
  upstream process arguments and gates newer speculative features by build
  capability. The argv the app's Rust plugins produced before stage 6 is frozen
  in `tests/fixtures/core-contracts/{args,args-llamacpp}` and replayed by the
  core; `tests/capabilities.test.mjs` checks every long flag in those fixtures
  against the pinned binary snapshots.
- `extensions/mlx-extension/src/index.ts` sends MLX settings to the core.
- `atomic-chat-core` `src/runtime/mlx/` translates them into the `mlx-server`
  process and readiness lifecycle (frozen argv in
  `tests/fixtures/core-contracts/mlx-args`).
- `atomic-chat-core` `src/server/public/` exposes the local OpenAI-compatible
  facade on desktop; `src-tauri/src/core/server/proxy.rs` still serves it on
  mobile.

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

- Desktop: `atomic-chat-core` `src/server/public/` and `src/server/shims/`,
  started through `src-tauri/src/core/server/commands.rs` (`CoreOwner`).
- Mobile: `src-tauri/src/core/server/proxy.rs` and
  `src-tauri/src/core/server/responses_shim.rs` (`LegacyOwner`).
- `web-app/src/hooks/useLocalApiServer.ts`

Rust tests cover route allowlists, authentication, model-id normalization,
proxy transformations, and Responses API translation. The frontend hook tests
cover state transitions. There is no real socket round-trip through the local
server to a deterministic backend stub.

`/v1/images/generations` and Remote & LAN (the `cloudflared` quick tunnel,
per-request trusted hosts, the LAN address list) are served by the core on
desktop (ADR 2026-09-18). Here the seam is proved by
`services/__tests__/app.test.ts` (the four remote-access calls hit their core
routes and a refused start keeps the core's `details` for
`parseRemoteAccessRejection`), `hooks/__tests__/useRemoteAccessSync.test.ts`
and `routes/settings/__tests__/remote-lan.test.tsx` on the page, and in Rust by
`atomic_core::launch` (`--cloudflared-bin` only when the sidecar is there),
`atomic_core::relay::legacy_events` (`download:stage` under the legacy task
name) and `server::api_request_analytics` (the image labels). A status read
the core fails no longer marks remote access unavailable
(`useRemoteAccess.test.ts`, `useRemoteAccessSync.test.ts`), and a core
failure reaches the UI and telemetry as its code (`remoteLan.test.ts`). The
llama extensions' index tests prove a relayed `download:stage` frame of a core
backend install becomes a named row's status, never progress. Nothing here
starts a tunnel or generates an image; the core's e2e and live tests do.

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

Cancelling a model load is the core's (`POST /models/:provider/:id/load/cancel`,
ADR 2026-09-18); the three runtime extensions share
`extensions/shared/loadCancel.ts` on top of it. `llamacpp-upstream-extension`
`src/adapter/sharedLoadCancel.test.ts` proves the protocol against a fake core:
the cancel is retried while the load request is still on its way, a session
that came up first is unloaded again, the load rejects with
`code: 'MODEL_LOAD_CANCELLED'`, and a core refusal keeps its code. Each
extension's `index.test.ts` (`mlx-extension/src/loadCancel.test.ts`) then
proves its own `load` reports the `installingEngine`/`loadingWeights` stages
before the core call and that `cancelLoad` reaches through it. The core-side
registry is proved in `atomic-chat-core` (test/e2e/load-cancel.test.ts there).

### Local image generation — partial, P1

Production entrypoints:

- `atomic-chat-core` `src/diffusion/` — the engine (`sd-server`) process, the
  jobs, step progress, the gallery and engine installs; reached through
  `/atomic/v1/diffusion/*` and relayed as `atomic-core://diffusion:*`
  (ADR 2026-09-18, image generation runs in the core).
- `web-app/src/services/diffusion/tauri.ts` — the seam: one `atomic_core_call`
  per operation, the core's four envelopes unwrapped, the four events plus the
  `atomic-core://snapshot` reset stamped with their discriminant.
- `web-app/src/stores/image-generation-store.ts` — binds to that service,
  adopts a running job, runs the multi-run loop
  (`seed = base + run × batchSize`), stops, lands outputs in the gallery, and
  configures the core again on every `reset` (each attachment's snapshot) with
  the idle interval and the output folder it keeps in `useImageSetting`.
- `web-app/src/services/diffusion/install.ts` — downloads and unpacks the
  engine here, asks the core for free space (`POST /disk/available`) and hands
  the tree over (`POST /diffusion/backends/finalize`).
- `web-app/src/containers/images/*`, `containers/dialogs/ImageSetupDialog.tsx`,
  `routes/settings/media.tsx` — the Images page, the first-run wizard and the
  Media settings page.
- `web-app/src/lib/diffusion/{size,recipe,generation-stop,errors,telemetry}.ts`
  — pure helpers: size snapping, recipe restore and export naming, the
  stop/report decisions, the error-code routing table, PostHog props.

Existing evidence:

- `services/diffusion/__tests__/tauri.test.ts` runs the production
  `TauriDiffusionService` against `mockIPC`: every operation hits its one core
  route with the interface parameters as the body, load and generate requests
  pass through unchanged, the four envelopes are unwrapped, ids are escaped, a
  core refusal keeps its `code`, and `subscribe` listens on the four relayed
  events plus the snapshot reset and detaches each listener exactly once.
- `image-generation-store.test.ts` drives the loop against a fake
  `DiffusionService` and asserts the seeds handed to `generate`, the gallery
  order after three runs, that Stop ends the loop without a toast, that a
  failure stops it with the code surfaced, the 2 s `getJob` fallback when the
  terminal event never arrives, adoption of `getStatus().activeJob`, that bind
  and a `reset` both re-send the stored output folder, that a folder the core
  cannot create falls back to the default while the choice is kept (and that a
  core outage does not), that a `reset` drops stale capabilities, and that the
  telemetry payload carries neither prompt nor seed. `media.test.tsx` proves
  the chosen folder is persisted, a refused one leaves the old choice, and
  picking the default folder stores none. `lib/diffusion/__tests__/errors.test.ts`
  walks core and relay codes outside the 21 (message kept, code in details).
- `services/diffusion/__tests__/install.test.ts` proves the engine install
  end to end against the download and core mocks: the host's qualifying
  build, the free-space refusal and the go-ahead when the core cannot tell,
  retiring the previous tree unless a session still runs from it.
- The core's own evidence — the hand-ported sd.cpp tables, the fake
  `sd-server`, the diffusion e2e on the compiled binary (test/e2e/diffusion.test.ts
  there) and the live run on a real engine (test/live/diffusion.test.ts) —
  lives in `atomic-chat-core/docs/testing-critical-flows.md`.
- `size.test.ts`, `recipe.test.ts`, `generation-stop.test.ts`, `errors.test.ts`
  cover the pure helpers as tables; `errors.test.ts` walks every code in the
  contract and checks each has English copy.
- `useImageArtifact.test.ts` derives installed/downloading/loaded from the
  real `listInstalledArtifacts` and the download store.
- `ImagePromptForm.test.tsx`, `ImageJobProgress.test.tsx`,
  `ImageModelSelector.test.tsx`, `ImageViewer.test.tsx`,
  `ImageSetupDialog.test.tsx`, `media.test.tsx` render the production
  components against the fake service and assert what the user sees: the
  Ctrl+Enter submit, the Generate/Stop swap, capability-gated controls, the
  download plan's present/missing rows, Restore filling the form with the batch
  seed, the export filename handed to the save dialog, delete removing the
  tile, the wizard's Done gate, and the output-folder change.
- `NavMain.test.tsx` checks the Images row sits after Models and disappears
  without the media-generation feature.

Gap:

- The store's event handling is proved only through the fake service; no test
  drives the production store through the relayed `atomic-core://diffusion:*`
  events end to end.
- The full-page composition (`ImageGenerationPage`) and the deep-link
  `?model=&quant=` preselect have no test.
- OS notification on completion and the GPU arbiter hand-off are mocked.
- `make test-core-live` does not yet generate an image through the packaged
  app core; the live engine run is the core's `ATOMIC_LIVE=1` test.

### Local video generation — partial, P1

Production entrypoints:

- `atomic-chat-core` `src/diffusion/{video-job,video-gallery,video-recipe}.ts`
  and `src/server/public/videos.ts` — the video job on the same resident
  `sd-server` session, the WebM gallery with its JSON recipe sidecar and the
  app-made poster, and the OpenAI-shaped `/v1/videos` facade; reached through
  `/atomic/v1/diffusion/video/*` and relayed as
  `atomic-core://diffusion:video-progress` / `video-job` (ADR 2026-09-23,
  one runtime, two pages).
- `web-app/src/stores/image-generation-store.ts` — the modality axis: the
  `videoCapabilities` slot, `lastErrorModality`, the video branch of
  `loadModel`, the configure that carries `videoOutputDir`.
- `web-app/src/stores/video-generation-store.ts` — one clip per Generate:
  validate, submit, wait for the terminal `video-job` with a polling
  fallback, land the clip, render and upload its poster, report without the
  prompt or the seed; adoption of `status.activeVideoJob` on bind.
- `web-app/src/stores/media-gallery-store.ts` — the paged, selectable
  gallery both the image and the video gallery are instances of.
- `web-app/src/hooks/{useVideoSetting,useVideoForm,useVideoGeneration}.ts`,
  `lib/video/{duration,validate,recipe,poster}.ts` — the video settings and
  form, the request builder, the frame-lattice durations, the request
  validation mirrored from the core, recipe restore and export naming, and
  the poster capture with its data-URL fallback and backfill queue.
- `web-app/src/containers/videos/*`, `containers/dialogs/DeleteGalleryVideosDialog.tsx`,
  `routes/videos/index.tsx` — the Video page; `ImageSetupCard`,
  `ImageSetupDialog`, `ImageEmptyState`, `ImageGenerationPlaceholder`,
  `ImageApiSettingsCard` and `ImageModelPicker`/`Selector`/`RuntimeAction`
  serve it through a `modality`, `kind` or `resource` prop.

Existing evidence:

- `services/diffusion/__tests__/tauri.test.ts` covers the ten video
  operations on their `/video/*` routes and the two video events beside the
  image ones.
- `image-generation-store.test.ts` (the `video models` block) proves a video
  checkpoint loads into the video slot with the audio VAE and the connectors
  on the request and in the GPU budget, records the Video page's selection
  and resets the video form while the image side is untouched, files a
  failed video load and a refusal under Video, reads the video capabilities
  of an already resident video model on bind and on a state event, clears the
  Video selection on removal, and sends `videoOutputDir` with every configure
  and drops both folders when one is unusable.
- `video-generation-store.test.ts` drives a clip from submit to gallery
  against the fake service: progress marks the job generating, the clip is
  prepended and gets a poster through `setVideoPoster`, the telemetry carries
  neither prompt nor seed, a failure is surfaced and a user Stop is not, a
  second Generate is ignored while one runs, the polling fallback lands a
  clip and fails a forgotten job, a foreign completed job lands with a
  poster, a running job is adopted on bind, and a failed poster capture is
  remembered and not retried.
- `media-gallery-store.test.ts` covers paging without doubling, selection
  survival across a reload, prepend under live and gallery modes, `patch`,
  removal landing on the neighbour, shift/meta selection and stepping.
- `lib/video/__tests__/{duration,validate,recipe,poster}.test.ts` are tables:
  1/2/3/5 s become 25/49/73/121 frames on both lattices, off-lattice and
  out-of-range counts are refused with the core's messages, image-to-video
  is refused in every spelling, the export name and the restored draft,
  and the poster capture against a scripted `<video>` (decode, seek, error,
  tainted canvas with the data-URL fallback, timeout, the backfill queue's
  concurrency and no-retry rule).
- `VideoPromptForm.test.tsx`, `VideoViewer.test.tsx`,
  `VideoGenerationPage.test.tsx` render the production components against
  the fake service: Generate gated on a prompt and submitting the video
  request, Ctrl+Enter, the family presets and lattice durations with the
  fixed rate, guidance and the negative prompt hidden for LTX and shown for
  Wan, the Advanced fold writing to the shared image settings and showing the
  `/videos` API card, the player fed over the asset protocol with its poster
  and the system-player fallback on a decode error, a poster-less tile
  asking for and receiving its poster, Restore with the requested frame
  count, the model switch offer, Save as, reveal, delete, the arrow and
  Delete keys, the onboarding card for video, the empty canvas asking for a
  video model while only an image one is on disk, the deep-link preselect,
  the live placeholder with the pending tile, and which errors the page shows
  and clears.
- `ImageSetupCard.test.tsx`, `ImageSetupDialog.test.tsx`,
  `ImageGenerationPlaceholder.test.tsx`, `ImageModelPicker.test.tsx`,
  `ImageModelSelector.test.tsx`, `NavMain.test.tsx` and `media.test.tsx`
  cover the shared components' video variants: the card's copy, done row and
  wizard modality, the wizard keeping its modality across steps, the video
  progress words, a resident video model kept off the Images picker, the
  selector's modality filter writing the Video selection, the sidebar row
  after Images, and the video output folder's change, default and refusal.
- `VideoStudio.layout.test.tsx` and `VideoViewer.layout.test.tsx` (browser
  layout suite) hold the resolution and duration pills on one line in the
  340 px column at both type sizes, the Advanced fold at the card width with
  the video API card, the player frame at the clip's aspect inside the
  region, the toolbar on one row with labels folded below 32 rem, and video
  tiles the size of image tiles with the duration badge inside.
- The core's own evidence — the video block of the fake `sd-server`, the
  video e2e on the compiled binary (`test/e2e/video.test.ts`,
  `test/e2e/videos-api.test.ts`) and the live block — lives in
  `atomic-chat-core/docs/testing-critical-flows.md`.

- `tests/e2e/desktop/video-{generation,failures,settings,chat-handoff}.spec.ts`
  (harness `videos.ts`) drive the built app on the core's scripted engine
  in video mode: the model loaded with the audio VAE and the connectors on
  the argv, a clip generated and played by the webview itself (metadata and
  a frame size read back from the player), its poster rendered by the app
  and stored as `<id>.thumb.png`, the WebM and its JSON sidecar on disk, the
  gallery back after a restart; a clip the engine fails and one stopped
  halfway; the video folder changed in Settings → Media and kept across a
  restart, a clip deleted with its sidecar and poster; the chat model
  evicted for a video model and brought back. Run on 2026-09-23 on macOS
  arm64 against core 0.4.0: every scenario passes; the restart scenario's
  teardown reports a leftover bundled llama.cpp backend process, which the
  unchanged image restart scenario reports on the same machine too.

Gap:

- No live run through the packaged app core; the live engine run is the
  core's `ATOMIC_LIVE=1` video block, still to be run on a real LTX-2.3.
- OS notification on completion and the GPU arbiter hand-off are mocked, as
  for images.

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
5. The local OpenAI-compatible API has a real socket round-trip to a
   deterministic backend stub on macOS only
   (`tests/e2e/desktop/local-api.spec.ts`); the default gate has none.
6. Hub download/start has a production route journey on macOS
   (`tests/e2e/desktop/hub-download.spec.ts`) against a local fixture. Launch-agent
   configuration has one on macOS (`tests/e2e/desktop/launch-integration.spec.ts`);
   agent installation has none.
7. Data-folder relocation has a success-and-refusal journey on macOS
   (`tests/e2e/desktop/data-folder.spec.ts`); a failure in the middle of the
   copy is still untested.

### P1 — important supporting evidence

1. UI thread rehydration after desktop restart is proved on macOS by
   `tests/e2e/desktop/local-chat.spec.ts`; Windows and Linux have no desktop
   journey yet.
2. llama.cpp error classification and extension stream cancellation are thin.
3. Sidecar orphan cleanup is tested as a lifecycle on macOS
   (`tests/e2e/desktop/recovery.spec.ts`: a killed core's backend is reaped by
   its successor); the default gate still has matching logic only.
4. ServiceHub construction is smoke evidence; adapter behavior belongs to the
   dedicated `mockIPC` suites.
5. Local image generation is proved through the seam (`tauri.test.ts`) and a
   fake `DiffusionService` in the store; the page composition and the
   deep-link preselect are untested, and no app-level test generates an
   image through the packaged core.

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

### Implemented journeys (macOS arm64, `make test-app-e2e`)

How the suite is built and isolated:
[Drive the desktop UI through an embedded WebDriver on an isolated profile](decisions/2026-09-18-drive-the-desktop-ui-through-an-embedded-webdriver-on-an-isolated-profile.md).
The suite is outside `make verify`.

| Contract item | Owning test | What it proves | What it does not |
| --- | --- | --- | --- |
| 1. Clean onboarding | `tests/e2e/desktop/onboarding.spec.ts` | an empty isolated profile reaches the production setup screen; the app config on disk and over IPC name the same data folder; skipping completes setup and survives a full restart; a build without its own root refuses to start | no backend recommendation is asserted (macOS has no backend step); completing setup by downloading a model is not covered |
| 2. Hub install | `tests/e2e/desktop/hub-download.spec.ts` | the Hub landing page offers the model a fixture catalog and picks registry publish; "Download" goes through the shipped path (extension import, the app's downloader, the GGUF check); while the file arrives the Downloads panel shows a share of the real total with Pause and Cancel; the whole file and its `model.yml` land under the quant's id; the file is requested without any token; "New chat" hands the model to a chat that is answered, with the core's session under that id. Cancelling midway leaves no registered model and no completion, and the same model then downloads to the end. Pausing holds the bytes on disk still and registers nothing; resuming asks the server for the rest with a `Range` request rather than for the file again, and the finished file has the fixture's sha256 (the fixture's bytes encode their own position, so a misplaced resume would change it) | the catalog, the picks and the file come from `http://127.0.0.1` at a port baked into the e2e build, which the upstream extension now accepts as a download address for loopback hosts only; a pause that outlives the app; a server that ignores `Range`; a failed or corrupt download; sha256 and size verification (the Hub skips both); sharded models, mmproj, MLX |
| 2. Backend install | `tests/e2e/desktop/backend-install.spec.ts` | "Install Backend from File" in the provider's settings, given a release archive from the user's home: the archive is unpacked where the core looks for backends, the executable bit survives, the page names the new `version/backend` as selected, and the previous backend stays installed. A model that is already running keeps answering from the old backend (pinned; the page does not say so); after it is stopped on the same page, its next load runs the installed one — proven by that backend's own reply and by the executable in the core's process journal. A newer release is also found and installed without a click: a release published on this machine behind a loopback CONNECT proxy, reached through the user's proxy setting with "Ignore SSL certificates" on — the manifest is asked for through the proxy, the core downloads the archive from the host the manifest names, checks it against the manifest's sha256, unpacks it, and the next load answers from it. (This path was dead before 2026-09-18 for two reasons the scenario found: the HTTP plugin refused proxied requests that ignore certificate errors, and its pinned JS client 2.5.0 never delivered a response body from the Rust plugin 2.5.7.) | the manifest address itself cannot be set on either side, so the proxy is the only way in, and three of the manifest's four routes ignore the proxy by design — the scenario falls back to "Check engine updates" when a direct route wins with the real catalog; a checksum mismatch seen from the UI. Windows `.zip` archives; CUDA companions; removing a backend |
| Local API after the core dies | `tests/e2e/desktop/local-api.spec.ts` (second scenario) | with the server started from the API page, the core is killed: the listener goes with it, the supervisor starts another core, and the server is listening again on the same port with the same key (401 without it) with nobody touching the app; the model it was serving is loaded again — a session for it appears in the new core — and a streamed completion from the outside client is answered; the page still shows the server as running. Until 2026-09-19 only the listener came back: the core's public server loads nothing itself, so every request got `503 No models are available` until the user did something in the app; and the model had been remembered under the first provider that lists it, which for a llama.cpp model is TurboQuant — off, with no backend | a core that dies in the middle of a streamed reply; several models served at once; a model that fails to load again (logged, the listener stays up); the tray's start/stop |
| Factory reset | `tests/e2e/desktop/factory-reset.spec.ts` | with a conversation, a local model and a cloud provider connected with a key (found in `atomic-core/credentials.json` beforehand), "Reset" in settings and its confirmation restart the app by itself; it comes back on onboarding, the previous core is gone, the thread and the model are gone from disk, the key is in no file under the data folder, the default provider's downloaded backend is still there, and a file of the user's own in the folder is untouched. Until 2026-09-21 the reset left the whole `atomic-core/` folder — the cloud keys included — and the ChatGPT subscription's token file, and kept only TurboQuant's backends, so the default provider's backend was thrown away and fetched again | the webview's own storage is cleared by the web app and re-seeded by the e2e build, so what survives there is not judged; the ChatGPT token file is covered by the unit test only; Windows file-handle timing; a reset while a download runs |
| Restart by the app itself | `tests/e2e/desktop/relaunch.spec.ts` | `relaunch` — the call the updater, the backend dialogs and the settings pages end with — takes the app's core down with it (the previous core's pid is gone when the new app is up), the restarted app has a core of its own within fifteen seconds, the conversation is there and the next message is answered. Until 2026-09-19 the restart replaced the process without the exit handler, the core stayed up holding the folder's lock, and the new app waited about 45 s for the vanished app's lease to lapse | **open, unexplained:** twice in some forty full runs this scenario hung until the test's own limit, and twenty loaded repetitions did not reproduce it. The WebDriver client used to wait two minutes, three times, for a command the app never answered — longer than any test — so the hang left no error and no artifacts; commands now fail after thirty seconds, by name, and the next occurrence will say which one. The AppImage restart path on Linux still spawns and exits without the exit handler; a restart in the middle of a download or a generation; the updater's own install step |
| 7. MCP tool in a chat | `tests/e2e/desktop/mcp-tool.spec.ts` | the app starts the stdio MCP server named in `mcp_config.json`, offers its tool to the model, the scripted model calls it with its own arguments, the server receives exactly that call and its answer reaches the model. Once the user picks "Ask for approval" in the composer, the call waits in "Tool Approval Required" naming the tool: Deny keeps it from the server and the model is told "Tool execution denied by user"; Allow Once lets it through. On a thread whose approval mode was never touched, MCP tools run unprompted — they follow the global "Allow All MCP Tool Permissions" switch in Settings, which the app deliberately turns on for everyone — while the composer's select shows its plain default, "Ask for approval". From 2026-09-19 to 2026-09-22 the label added "· MCP tools auto-approved" there; that was reverted (2026-09-22 record). The scenario pins both the label and the behaviour | the server is a fixture with one tool; HTTP/SSE servers; "Always allow"; per-tool disables; a server that dies or times out; the settings page for MCP servers |
| 8. Agent mode, local model | `tests/e2e/desktop/agent-mode.spec.ts` | with Agent mode on, the Rust loop drives the chat model's own core session through the raw `/completion` endpoint (no second session appears): it reads a file in the default workspace, writes one there without asking, and for a write outside the workspace shows "Allow folder access" naming the tool and the folder, with nothing written meanwhile. Refused, the file is never created; allowed, it is written. Either way the turn ends with the model's reply, and the reply shows the read file's text had reached the model's prompt | the model's part is three scripted steps: the grammar, the prompt, repair steps and loop guards are not exercised by a real model; shell, web and git tools; MCP tools inside the agent (`mcp.*`); cloud and MLX transports; cancelling a run; whether a second approval follows "Allow folder" is tolerated, not asserted |
| 6. Document attached for retrieval | `tests/e2e/desktop/document-attachment.spec.ts` | a text file chosen through the composer's menu is attached to the thread; with the next message the app parses and chunks it and the core embeds the chunks — the embedding model runs as a process of its own with `--embedding --pooling mean` — and the thread's collection holds one file and one chunk with the document's words and exactly the vector the scripted backend gives for a text of that length. Then the model asks: the app offers `retrieve` because the thread has documents, the scripted chat model calls it, the query is embedded by the core and matched, and the tool's result in the thread store carries the document's words, which the model's answer repeats. Nothing is downloaded: the embedding model is placed in the profile. **Found by these tool scenarios and fixed on 2026-09-19:** about once in a dozen long runs a turn in which the model calls a tool ended empty. Replies from local models are relayed over an IPC channel, and every reader took the relaying command's return for the end of the stream; the return can overtake chunks still on their way, and a reply of two chunks — a tool call — was closed before it arrived. The end now travels on the channel. The scenario still prints the thread store and the tool-related console lines if a tool turn ever ends empty again. The thread's collection is in `<data folder>/db` and nothing is left in the fixed place under the home directory the plugin used until 2026-09-19 (it ignored the data folder, so a moved folder left the indexes behind and a factory reset did not remove them) | the file is picked through the e2e build's dialog queue, not the native dialog; drag-and-drop; `auto` and `inline` modes and the per-file prompt (the scenario pins `embeddings`); PDF/DOCX parsing; ranking among many chunks (the scripted vectors differ only by text length); the ANN index (`sqlite-vec` ships on Linux only; the scenario pins linear search); project-scoped collections; the agent's `docs.*` path |
| 4. Local API request log | `tests/e2e/desktop/api-inspector.spec.ts` | with the API page open and the server started, a streamed completion made by an outside client appears in the list by itself — nobody reopens or refreshes the page — and opens to its method and path, the prompt it carried, the reply it got and its stop reason; a request refused for lack of a key is counted as the one error (Requests 2, Completed 1, Errors 1). This is the path core → Rust relay → inspector → webview; until 2026-09-18 its last step dropped every live event, because the emitter was bound only when the app's own proxy started, which no longer happens with the core serving the API | token counts and speeds are whatever the scripted backend yields, not checked; progress events while a long reply streams; the log's filters, search and Clear |
| 5. On-device Foundation Models | `tests/e2e/desktop/foundation-models.spec.ts` (macOS only) | when the bundled server answers `--check` with `available`, the provider is offered in the picker, its one model is picked and answered, and the core's session is `foundation-models` / `apple/on-device`; when it answers `notEligible`, the provider is not offered at all | the server is the core's scripted sidecar brought by the profile, as for MLX: nothing of Apple Intelligence runs; `appleIntelligenceNotEnabled` and the other answers; the settings page's explanation of why it is unavailable |
| 5. MLX provider | `tests/e2e/desktop/mlx-provider.spec.ts` (macOS only) | a model folder under `mlx/models` is listed under the MLX provider, picked there, and answered; the core's session says `provider: mlx` and its process is `mlx-server` started with `--model <the folder>` and a `--max-kv-size` | `mlx-server` is the core's scripted sidecar, which the profile brings in `<root>/sidecars`, where an e2e build looks before its own `resources/bin`; nothing of MLX itself runs (weights, vision, draft models, KV overflow growth); MLX model download and import |
| 5. Second llama.cpp provider | `tests/e2e/desktop/turboquant-provider.spec.ts` | the TurboQuant provider is off on a fresh install and is turned on from its page in settings; with both llama.cpp providers on, the same model has a row under each in the picker; picked under the fork it is answered by the backend installed for `llamacpp` and the core's session says `provider: llamacpp` with the executable under `llamacpp/backends/`; picked under the default provider it is answered by the other backend, the session says `llamacpp-upstream`, and the fork's process is gone — one model, one process | the fork's backend is the scripted one: nothing TurboQuant-specific is exercised (cache types, flash-attn, its release index and updates); turning the provider off again; MLX and Foundation Models |
| 3. Working with a conversation | `tests/e2e/desktop/chat-workflows.spec.ts` | Stop cuts a streaming reply: Send comes back, the text stops growing, the reply's end never arrives, the model's process stays the same and answers the next message. Regenerate replaces the assistant's turn (new id, same user turn, one reply on the page); rewriting the question replaces it and its answer; deleting a message removes it from the page and from `messages.jsonl`; a thread is renamed (sidebar and `thread.json`) and deleted (sidebar and disk), both from the row's menu by keyboard. A stopped reply stays on the page and what was received of it is saved as the assistant's turn with status `stopped` | whether Stop reaches the backend (the scripted one cannot tell); branching, search, projects, attachments; the reply is the same text every time, so "another answer" is proven by the turn's id, not its words |
| 2. Model start and first streamed reply | `tests/e2e/desktop/local-chat.spec.ts` | a model picked in the UI is loaded through the core; the deterministic backend's exact reply is rendered; the session resolved by the webview equals the one in the core's `/sessions`; the spawned process is the fixture backend and no other backend got installed; both turns are persisted; a backend that dies while loading surfaces its stderr and error code with a retry, and leaves no session or process | the model and backend are placed on disk by the fixture (the Hub path is the row above); stream order is not asserted beyond the final text |
| 3. Thread persistence across restart | same test | after a full restart the thread is listed and its reply rehydrates from disk | the thread is titled by its prompt, not renamed |
| 4. Local OpenAI-compatible API | `tests/e2e/desktop/local-api.spec.ts` | nothing listens until the user starts the server in the UI; an outside HTTP client is refused without the key, lists the app's model with it, and receives a multi-chunk streamed completion whose text is the fixture backend's exact reply, loaded on demand by the core; stopping it in the UI closes the port | the port and key come from a seeded profile, not from typing into the settings popover (its inputs have no accessible names yet); `/v1/responses` and `/v1/messages`, trusted hosts and CORS are not covered |
| 5. Launch integration | `tests/e2e/desktop/launch-integration.spec.ts` | with a stand-in `codex` on the app's PATH and a stand-in home, "Run" on the Integrations page starts the local API, writes `~/.codex/config.toml` naming that API and the running model while keeping the user's own keys and tables verbatim, and asks for one terminal running the agent; a second run leaves the same meaningful lines and the same number of managed blocks | an e2e build records the terminal it would open instead of opening one, so the terminal itself and the agent's first request are not covered; one agent of many. A second run leaves the file byte for byte as it was (until 2026-09-18 each run added two blank lines). |
| 6. Data-folder relocation | `tests/e2e/desktop/data-folder.spec.ts` | with a thread in the original folder, "Change Location" and its confirmation copy the data, record the new path and restart the app by itself; the restarted app reports and stores the new folder, lists the thread and rehydrates its reply from there, loads a model from there and writes the next message to the new folder only — and the core serves the new folder within fifteen seconds of the restart (the move stops the core first and leaves its lock, token and process journal behind; before 2026-09-18 the copied lock kept the new folder unserved for about 40 s). When the target cannot be created the user is told why, in the command's own words, no restart happens, the model answers again without one, the configuration still names the old folder and the thread loads from it after a restart | the folder picker is a native dialog: an e2e build answers it from a queue the test fills, so the dialog itself is not covered; the failure is injected through a read-only parent, not mid-copy. A copy that fails midway brings the core back (`resume`), which is unit-tested by construction only — no scenario breaks a copy in progress |

Journeys beyond the six contract items, all against the core-owned runtime:

| Flow | Owning test | What it proves | What it does not |
| --- | --- | --- | --- |
| Sidecar lifecycle: backend crash | `tests/e2e/desktop/recovery.spec.ts` (seen once in about 25 full runs and fixed on 2026-09-19: after the core is replaced, a model loaded while the event stream was still reconnecting had a session the app's mirror had not heard of, and the message failed with "No running session found"; a lookup that misses now asks the core before giving up) | killing the backend under a loaded model removes its session from the core, shows the crash toast, and the app restarts the model by itself; the next message is answered by a new process and exactly one backend is left | a crash in the middle of a stream; the composer ignores Enter while the model reloads (its send button is disabled), which the test waits out as a user would |
| Sidecar lifecycle: core crash | same file | killing the core daemon under a running app yields a new ready instance from the app's supervisor, the orphaned backend is reaped rather than adopted, the next message loads the model under the new core, and no crash toast is shown for a death that was the owner's | the three-restart ceiling; a crash while a request is in flight; the public listener coming back |
| Context overflow: growth | `tests/e2e/desktop/context-growth.spec.ts` | with the provider's `fit` off the core passes an explicit window; a backend that answers `exceed_context_size_error` below a threshold makes the app grow the window past it, replace the process and deliver the reply with no growth indicator, error text or crash toast left | `fit` is turned off by a seeded extension setting, not in the settings UI; the proxy and agent overflow paths; the ladder's cap at the training maximum |
| Context overflow: `fit` on (as shipped) | same file | the user is told the context is fitted to the device's memory | **known defect, recorded with `it.fails`:** afterwards the thread is a dead end — "Growing the Mind..." never clears, no error or Retry appears and the send button stays disabled, because `handleContextSizeIncrease` returns on `fit`/`at_max` without lowering `isAutoIncreasingContext` or the active-request flag (`routes/threads/$threadId.tsx`) |
| Provider setting UI → core → backend | `tests/e2e/desktop/provider-settings.spec.ts` | "Fit context to device memory" switched off on the provider's settings page reaches the core's settings file and the next backend's argv (`--fit off`); after a full restart the switch and the core still agree; switching it back is a higher core revision and the next backend runs without the override | one boolean setting of one provider; the page is reached through the model picker's settings button, which got a `data-test-id` for this (it is an icon-only `div`) |
| Real backend and model (opt-in, `make test-app-e2e-live`) | `tests/e2e/desktop/live-model.spec.ts` | a real `llama-server` from a backend directory the operator names starts with the argv the core builds and is recognised as ready; a real model answers; the stored reply is the one shown; the process is the copied binary; stopping the core stops it | what the model says; `runtime_device` — llama-server b10809 on macOS prints no log lines by default, so the core reports an empty device and backend-mismatch detection never gets a positive signal there |
| Cloud provider through the core | `tests/e2e/desktop/cloud-provider.spec.ts` | a custom OpenAI-compatible provider created on the Cloud page (the provider menu is driven from the keyboard) connects with a key to a scripted endpoint that answers 401 without it; the core lists the provider and does not hand the key back; a chat in the app gets the endpoint's reply and, with auto-start off, is what starts the local API — the app reaches a cloud provider through the core; an outside client of the local API naming the cloud model gets the reply while the endpoint receives the provider's key, which that client never had; the key is absent from the core's settings file, the app log and the page | the model is added by hand: "Reload models" refreshes the provider registry first and gives up when it is unreachable, as it is in an e2e build, before asking the provider. Found on the way and fixed on 2026-09-18: a custom provider used to be created with OpenAI's address and at once asked `api.openai.com` for models (it is created without an address now, OpenAI's stays as the field's placeholder); a model-list request that finished late could replace a newer list or write back an older key (the list is written alone, onto the provider as it is when the answer lands); and "Reload models" stopped at an unreachable registry without asking the provider's own endpoint — all three covered by unit tests, not by this scenario |
| Model stopped by hand | `tests/e2e/desktop/model-stop.spec.ts` | "Stop" in the provider page's row unloads the model in the core and ends its process with no crash toast; back in the conversation, with the model still selected, auto-start leaves it down; the next message brings it back and is answered | "Start" in the same row; MLX and TurboQuant |
| Model switch | `tests/e2e/desktop/model-switch.spec.ts` | picking another local model mid-conversation leaves one session in the core — the new model's — ends the first model's process, shows no crash toast for that deliberate stop, and the conversation continues | unloading from Settings; MLX and TurboQuant; two providers holding the same model |
