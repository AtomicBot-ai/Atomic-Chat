---
date: 2026-09-22
title: "Sequence executable TensorRT-LLM agent tasks"
status: proposed
---

# Managed text engines: coding-agent backlog, TensorRT-LLM first

Apply the [shared-engine decision](2026-09-22-share-managed-text-runtime-infrastructure.md) and the
product decisions in the [architecture's §0](2026-09-22-propose-managed-tensorrt-llm-architecture.md).
T00-T24 remain parent labels; T10 (session gateway), T12 (caller migration) and T23 (separate NVFP4
qualification) are withdrawn. Dispatch lowercase-suffix children only.

- **Context:** The [implementation plan](2026-09-22-plan-managed-tensorrt-llm-implementation.md)
  describes work packages; agents need bounded assignments with stable interfaces.
- **Decision for this backlog:** Use the [coding contracts](2026-09-22-specify-managed-runtime-coding-contracts.md)
  and execute one child at a time. A card delivers code and evidence, not another plan.
- **Consequences:** Shared files have one writer at a time. Core/app protocol changes are paired.
  Hardware cards name their host.
- **Owner:** the operator with coding agents. Progress is marked per child below. This document does not
  authorize committing, publishing or changing a test host.

## Dispatch rules

Repositories: `CORE` = sibling `atomic-chat-core` (branch `feat/tenzor-rt`); `APP` = this
`Atomic-Chat` checkout (branch `feat/tenzor-rt`); `CONF` = `AtomicBot-ai/atomic-chat-conf` (not
checked out). Paths are repository-relative. **new** marks a proposed file. Companion tests sit
beside modules using the repository's conventions. Agents read the applicable AGENTS.md.

1. Assign one card with its dependencies integrated. Paired cards get both checkouts.
2. Recheck the working tree before editing; preserve unrelated work, including APP `tests/e2e/`.
3. Modify only the card's scope plus required exports, adjacent tests, fixtures and ADR entries. If a
   shared contract must change, stop and amend its owning card first.
4. No new runtime dependencies without the repository's explicit approval.
5. Complete code and tests in the same card. Missing hardware marks a live check pending; it cannot
   complete a hardware-gated card. Never replace production code with a stub to pass a gate.
6. Finish with files changed, behavior, exact commands and results, blockers and next unlocked IDs.
   Do not commit, open PRs, publish or provision a host without authorization.
7. Text inference only. Existing image work is touched only by the residency rule.

### Verification attached to every card

- CORE: focused adjacent tests while iterating; `npm run verify` before handoff. Runtime changes
  also run `npm run test:e2e`; record the OS. Update `docs/testing-critical-flows.md` for affected
  flows.
- APP: focused workspace lint/tests through `volta run --yarn 4.5.3 yarn …`; Rust changes need
  `cargo check` and `cargo clippy` in `src-tauri/`; final `make verify`. Paired contracts also run
  `node --test tests/core-contracts.test.mjs` after fixture emission and CORE import.
- CONF: its own validation workflow once checked out.
- A blocked command is reported, never silently skipped.

## Dispatch children, never a whole parent

- First queue: **T00a**, **T00b**, **T01a**. After T01a: **T01b**, **T01c**, **T02a**, **T03a**,
  **T04a**, **T08a**, **T09a**, **T11a**.
- Live cards need real hosts: T03c (Ubuntu 4070), T03d (Windows 4070), T03e (5090), T07c, T08e,
  T09g, T14e, T22a/T22b. T20b needs a writable CONF checkout; T21 needs signing inputs.
- No overlapping writers for contract exports, `core/create.ts`, control router/types, runtime
  registration, the app core pin or fixture checksums.
- Tests named OPxx/GPUxx are traces in the coding contract.
- Do not add future-engine stubs, plugin loading, image functionality, global Docker mutations or
  arbitrary privileged execution.

## T00 — restore the documented verification toolchain

### T00a — Record APP baseline checks

**Status:** done 2026-09-22. `make verify` exits 2. One guard fails and it is pre-existing: `check-test-quality` flags `web-app/src/providers/__tests__/restore-server-model.test.ts` (commit d4eb5efdd) for a test whose only assertions check mock invocation. It reproduces on a clean tree. Every other stage is green: lint 0 errors/29 warnings, typecheck, telemetry-props, hardening-contracts 60, coverage-critical 3928+241+285, test-rust 973. Toolchain note: `volta run --yarn 4.5.3 make verify` does not work, because `volta run` does not give yarn to child processes; prepend `$HOME/.volta/tools/image/yarn/4.5.3/bin` to PATH instead.

**Repository:** APP. **Depends on:** none. **Files:** none.
**Implement:** Run `make verify` with Yarn 4.5.3 through Volta; do not change `packageManager` or
lockfiles. **Acceptance:** checks start with the pinned version; unrelated failing suites recorded.

### T00b — Record CORE baseline checks

**Status:** done 2026-09-22, green. `npm run verify` exits 0 on macOS/Node 22.22.0/bun 1.3.14: 3080 unit+contract tests (2 skipped), 97.76% lines, 389 bun contract tests, 51 e2e.

**Repository:** CORE. **Depends on:** none. **Files:** none.
**Implement:** Run `npm run verify` with pinned tools; record platform and existing failures.
**Acceptance:** exact failed command reported if the baseline is broken.

## T01 — environment types, descriptor validation and fixtures

### T01a — Add environment wire types and error codes

**Status:** done 2026-09-22. New `src/contracts/environment.ts` (+ `ArtifactLocation`), managed codes in `errors.ts`, `environment:changed`/`environment:operation` in `events.ts`, barrel export, 14 tests. Renamed against the contract sketch where a short name was ambiguous in the shared barrel (`Phase`→`ManagedPhase` and friends, `Digest`→`Sha256Digest`); `Failure` is the existing `ErrorBody`; the `Id` alias was dropped. `EnvironmentSnapshot` gained `instance_id`/`revision` so the event-ordering rule is expressible. The contract document was amended to match.

**Repository:** CORE. **Depends on:** none.
**Files:** new `src/contracts/environment.ts`; `src/contracts/{index,events,errors}.ts`.
**Implement:** the wire declarations of the coding contract, including `GpuFacts`,
`relogin-required`, `MODEL_INCOMPATIBLE` and `ModelResolution`; no routes or I/O.
**Acceptance:** round-trip every phase, both targets, null progress, unavailable adapter;
existing event producers typecheck.

### T01b — Parse runtime descriptors and hash requests/plans

**Status:** done 2026-09-22. New `src/runtime/environment/{index,descriptor,canonical-json}.ts`, 26 tests. Descriptor validation rejects a mutable tag (a registry port still passes), a malformed digest, an unknown schema or field, a duplicate recipe/executor/architecture/format/model revision, an unregistered or version-mismatched adapter, a malformed compute capability and an unsafe byte count. Canonical JSON is deliberately separate from `settings`' `stableStringify`: it refuses what JSON would silently coerce, because its hashes back a privileged install. Size estimates are excluded from the plan hash on purpose.

**Repository:** CORE. **Depends on:** T01a.
**Files:** new `src/runtime/environment/{index,descriptor,canonical-json}.ts`.
**Implement:** `RuntimeDescriptor` validation (compute-capability strings, architecture list,
quantization matrix, curated models, entrypoint digest) and canonical-JSON SHA-256 helpers with an
injected adapter catalog.
**Acceptance:** reject mutable tag, malformed digest, unknown schema, duplicate recipes, mismatched
adapter, malformed capability; shuffled keys hash equally, reordered arrays do not.

### T01c — Add managed data-path helpers

**Status:** done 2026-09-22. `src/config/paths.ts` + tests (31), core ADR `2026-09-22-managed-runtimes-split-per-user-environment-from-per-scope-data`, `docs/contracts.md`. Two roots: the environment is per machine user at `<dataDir>/atomic-managed-runtimes/` (override `ATOMIC_CORE_MANAGED_ROOT`), everything one scope owns alone stays under `<data>/atomic-core/managed-runtimes/`. `encodeManagedId` makes any id one directory name; `managedHostPath` refuses a guest location.

**Repository:** CORE. **Depends on:** T01a.
**Files:** `src/config/paths.ts`; `docs/contracts.md`; tests beside config tests.
**Implement:** the shared per-user environment root and per-scope `managed-runtimes/` paths from
the shared-engine ADR; ID encoding; guest locations distinct from native. Record the layout.
**Acceptance:** Unicode and repo-slash IDs stay inside roots; traversal and guest-as-host rejected;
no directory created on import; legacy provider paths identical; app and CLI resolve the same
shared root.

### T01d — Emit and replay paired environment fixtures

**Status:** withdrawn 2026-09-22, folded into T16a. This card assumed the app's Rust implements the contract and emits fixtures from it, which is how every existing set works: those contracts were ported *out of* the app's Rust, so a Rust-emitted fixture is evidence from the real implementation. The environment contract runs the other way. It originates in the core, and the app's Rust has no environment types at all — it relays the JSON opaquely, and the consumer is the web app's TypeScript (T16a/T16b). Writing Rust structs that exist only to emit fixtures would prove nothing about the real consumer. Two ways out: emit the set from CORE, commit it into the app's fixture tree and have T16a replay it (this reverses the direction and needs `tests/core-contracts.test.mjs` to stop requiring a `.rs` source for every case), or fold this card into T16a, where the actual consumer exists. Decision: fold it into T16a. The fixtures are written where the consumer is, from the core that produces the shapes, so nothing is proved about Rust structs that would exist only to be emitted from. The app's `tests/core-contracts.test.mjs` keeps its rule that every case in the existing sets names a `.rs` source, because those sets really were ported out of Rust. T05b no longer depends on this card.

**Repository:** CORE+APP. **Depends on:** T01a, T01b, T01c.
**Files:** APP `src-tauri/src/core/atomic_core/test_support.rs`, `tests/fixtures/core-contracts/`;
CORE `test/contract/`, fixture importer.
**Implement:** emit fixtures from Rust in the established format; import into CORE. Include two fake
engine descriptors, a `relogin-required` operation and a `MODEL_INCOMPATIBLE` resolution.
**Acceptance:** APP checksum test and CORE replay agree; null, Unicode, errors and unknown schema match.

## T02 — session identity across core, extensions and Rust

### T02a — Make CORE session execution identity explicit

**Status:** done 2026-09-22. `src/contracts/{session,events}.ts` plus `hostPid` in `src/runtime/shared/process.ts`, 13 new tests and 13 existing call sites moved onto the guard. `SessionInfo.pid` is nullable with an execution kind and a generation beside it. Widening the type broke every place that turned a session into a number, which was the point: each one is native-only, and they now go through a guard that refuses a container session rather than handing back a pid that means nothing on this machine. Native records are untouched on the wire, because the kind is absent on everything a previous release wrote and absent means native. Committed as `eacedbf`.

**Repository:** CORE. **Depends on:** T01a.
**Files:** `src/contracts/{session,events}.ts`; native `SessionInfo` producers; `src/lock` consumers.
**Implement:** nullable PID, execution kind and generation fields, nullable unload-event PID. Native
producers stay numeric; native kill helpers reject container records.
**Acceptance:** native round-trip unchanged; container null PID survives serialization; guest PID
cannot reach native kill.

### T02b — Migrate APP session types and consumers

**Status:** done 2026-09-22. `core/src/browser/extensions/engines/AIEngine.ts` and `src-tauri/src/core/sessions/mirror.rs`, 6 new Rust tests. `SessionInfo.pid` is nullable with an execution kind and a generation beside it; no TypeScript consumer reads the pid at all, so that half is pure widening. The real find was in the mirror: it was keyed by `model_id` alone, so two engines holding a model with the same name overwrote each other and the app would have sent one engine's requests to the other's port. It is now keyed by engine and model, an unload names the engine it belongs to (falling back to clearing the name entirely when an older core does not), and a lookup that names no engine answers in engine-name order rather than hash order. `resolver.rs` and the other listed consumers needed no change: none of them reads the pid, and they all go through the mirror. Gates: lint, typecheck, hardening, coverage and 979 Rust tests pass; `make verify` still stops at the pre-existing `test-quality` failure recorded under T00a.

**Repository:** APP. **Depends on:** T02a.
**Files:** `core/src/browser/extensions/engines/AIEngine.ts`; `extensions/shared/atomicCoreRuntime.ts`;
`src-tauri/src/core/sessions/{mirror,resolver}.rs`; `web-app/src/lib/model-factory.ts`;
`web-app/src/lib/voice/engine.ts`; `src-tauri/src/core/agent/{target,rag_bridge}.rs`.
**Implement:** accept the revised session type; lookup identity is provider + model + generation;
every consumer reads `host:port` from the session and tolerates a null PID. No routing changes.
**Acceptance:** two providers with the same basename stay distinct; stale generation discarded;
native PID unchanged; Agent, voice and RAG tests pass with a container-shaped session fixture.

### T02c — Activate the paired session protocol and fixtures

**Status:** done 2026-09-22. Protocol 1 to 2 on both sides, with the six core assertions that pinned 1 moved with it and a new app test for the direction that matters: a core still speaking 1 is refused, because it would hand this app a session shape it cannot read and the session would vanish rather than fail. Version and owner-scope matching are untouched, and no container provider is registered. **Consequence:** the app now refuses the published core 0.3.0, which speaks protocol 1. Until a core release carrying this is cut, run the app against a locally built core (`ATOMIC_CORE_LOCAL` and `ATOMIC_APP_CORE_LOCAL` for `scripts/download-core.mjs`, or `ATOMIC_CORE_CMD`). The core pin moves in T21. The T01d dependency this card listed is gone with that card.

**Repository:** CORE+APP. **Depends on:** T02a, T02b.
**Files:** CORE `src/contracts/control-api.ts` and handshake tests; APP
`src-tauri/src/core/atomic_core/{client,supervisor,relay}.rs`; shared session fixtures.
**Implement:** bump protocol 1 to 2 as one paired change; keep exact version and scope matching.
**Acceptance:** mismatched protocol rejected; matched pair attaches and unload events replay.

## T03 — run the pinned experiments on the 4070 hosts and the 5090

### T03a — Build read-only host inventory harness

**Repository:** CORE. **Depends on:** T01a.
**Files:** new `test/live/managed-host-inventory.test.ts`; parsers under `test/helpers/`.
**Implement:** collect OS, GPU name, compute capability, VRAM, driver, RAM/disk, virtualization,
Docker (daemon, group, GPU test), WSL facts without mutation; explicit live opt-in; redacted output.
**Acceptance:** fixture Linux/Windows outputs parse; absent commands report unknown; default test
run never probes a host.

### T03b — Build pinned TensorRT experiment runner

**Repository:** CORE. **Depends on:** T03a, T01b.
**Files:** new `test/live/tensorrt-environment.test.ts`, `test/fixtures/tensorrt/experiment-descriptor.json`.
**Implement:** opt-in pull by digest, version check, model load, stream, cancel, unload, VRAM
before/after, watchdog kill, with model pins as required inputs.
**Acceptance:** fake failures identify the step; missing pin or opt-in prevents download;
interruption leaves an explicit owned cleanup inventory.

### T03c — Record Ubuntu 4070 evidence

**Repository:** CORE. **Depends on:** T03b. **Host:** Ubuntu 4070.
**Files:** new `docs/tensorrt-hardware-evidence.md` Linux section; qualified experiment fixture.
**Implement:** run the harness with the host's Docker adopted or the helper recipe applied by hand;
record package versions, shared-memory size, FP16 and FP8 model results, memory recovery.
**Acceptance:** a small model streams and cancels; exit frees memory; existing containers untouched.

### T03d — Record Windows 4070 evidence

**Repository:** CORE. **Depends on:** T03b. **Host:** Windows 4070.
**Files:** `docs/tensorrt-hardware-evidence.md` Windows section; fixture.
**Implement:** import a distribution, configure systemd, install guest Docker and Toolkit, run the
harness, measure Windows -> guest loopback and the heartbeat path options.
**Acceptance:** real response, cancellation and exit observed from Windows; pins recorded
independently of Linux.

### T03e — Record 5090 NVFP4 evidence

**Repository:** CORE. **Depends on:** T03b. **Host:** 5090 (when available).
**Files:** `docs/tensorrt-hardware-evidence.md` Blackwell section; fixture.
**Implement:** run NVFP4 checkpoints and the rc27 SM120 known-issue cases; record which
quantization formats load, memory and cancellation.
**Acceptance:** per-checkpoint result; the quantization matrix in the descriptor is filled from
this and T03c, not from memory.

## T04 — operation reducer and crash-safe store

### T04a — Implement the pure operation reducer

**Status:** done 2026-09-22. New `src/runtime/environment/state.ts` + 24 tests, and `src/util/result.ts` for the `Result` both this and T11a return (it lives in `util` so `src/core/gpu` need not import `src/runtime/environment`). Traces OP02, OP04, OP06 and OP09 pass, plus declined elevation, a helper that claims success the machine cannot show, stale and mismatched effect results, terminal no-ops and the revision rule. A bug the tests caught: a transition that issues no effect was clearing the effect still in flight, so a recorded cancellation orphaned the work it was about; there is now an explicit keep.

**Repository:** CORE. **Depends on:** T01a.
**Files:** new `src/runtime/environment/state.ts` and test.
**Implement:** setup/update/remove transitions, consent, `relogin-required`, `reboot-required`,
cancellation. Typed effect intents; no I/O.
**Acceptance:** OP02/OP04/OP06/OP09; illegal event leaves state unchanged; revision increments once.

### T04b — Implement CAS persistence and idempotency

**Status:** done 2026-09-22. New `src/runtime/environment/store.ts` + 17 tests. OP01, OP03 and OP08 pass, plus two cores racing on one environment, a lock released when the work inside it throws, a lock broken only after its TTL, and a fresh lock that is waited on rather than stolen. Every write keeps the previous record and swaps the new one in by rename, so a torn newest file falls back to a state the operation really was in; when neither copy parses the store fails closed rather than reporting an operation that owns nothing.

**Repository:** CORE. **Depends on:** T01b, T01c, T04a.
**Files:** new `src/runtime/environment/store.ts` and test.
**Implement:** persist fingerprint, revision, effects and receipts in the shared root; atomic writes;
exclusive file lock around CAS so app and CLI cores serialize.
**Acceptance:** OP01/OP03/OP08; two processes contending -> one operation; stale CAS no write.

### T04c — Implement inventory-based recovery

**Status:** done 2026-09-22. New `src/runtime/environment/recovery.ts` + 11 tests. OP05 passes: a distribution imported before the crash is adopted by verified identity and never imported again, repeated recovery does not record it twice, and something that exists but cannot be claimed blocks the operation instead of being adopted or deleted. A restart keeps the operation and request ids and the approval, moves ownership to the running core, drops the single-use authorization the dead core held, and always re-probes rather than trusting the stored phase.

**Repository:** CORE. **Depends on:** T04b.
**Files:** new `src/runtime/environment/recovery.ts` and test.
**Implement:** reconcile pending effects through injected inventory; preserve operation ID, refresh
instance/revision and nonce. Never adopt by name.
**Acceptance:** OP05; effect completed without record does not create twice.

## T05 — environment service, routes, snapshot and events

### T05a — Drive operations through injected effects

**Status:** done 2026-09-22. New `src/runtime/environment/service.ts` + 13 tests, and the in-memory store disk moved to `test/helpers/managed-store-fs.ts` so the store and service suites share one. OP02, OP03, OP04 and OP09 pass end to end against a fake provisioner, plus a host with no recipe (a blocker on the plan, and an explicitly failed operation rather than a thrown call), a step that throws, a retried begin, and shutdown leaving the record mid-flight for the next core. Two bugs the tests caught: `resume` and `cancel` applied their event but never ran the effect it issued, so an approval sat in `checking` and a cancellation sat in `cancelling` forever. The privileged step is not work the service performs: it hands the step out, marks it as running (so a cancellation is recorded rather than acted on) and waits for the app's receipt, which is then checked against the machine instead of believed.

**Repository:** CORE. **Depends on:** T04c.
**Files:** new `src/runtime/environment/service.ts`.
**Implement:** `EnvironmentService` over store/reducer with injected probe, provisioner, executor
and unload callbacks.
**Acceptance:** OP02/OP03/OP04/OP09 end-to-end with fakes; missing provisioner -> blocked state.

### T05b — Add control routes and client methods

**Status:** done 2026-09-22. New `src/server/control/routes/environments.ts` with 15 tests, the managed codes mapped in `src/server/http.ts`, a narrow `ManagedEnvironmentControl` in `types.ts` so the control layer does not depend on the runtime module, and seven client methods with 5 tests against a real server over a real socket. Bodies are validated including their unknown fields, and an id that is a path is refused before the service sees it. An unauthenticated call reaches nothing. A build with no managed runtime wired answers 422 rather than pretending. Two things the existing suite caught: a comment between `case` labels tripped `no-fallthrough`, and `MODEL_INCOMPATIBLE` is an image-generation code already pinned to 500, so the managed runtime carries it inside a model resolution instead of redefining its status.

**Repository:** CORE. **Depends on:** T05a.
**Files:** new `src/server/control/routes/environments.ts`; `src/server/control/{router,types}.ts`;
`src/client/control-client.ts`.
**Implement:** exact route/body/status contracts with existing auth; no per-route Tauri commands.
**Acceptance:** 401 zero effects; 400/404/409 cases; duplicate receipt returns current state.

### T05c — Wire startup recovery, snapshots and SSE

**Status:** done 2026-09-22. New `src/runtime/environment/wiring.ts` with 10 tests, `create.ts`/`atomic-core.ts` wiring, the snapshot fields in `control/types.ts` and `router.ts`, the same fields on the client's `CoreSnapshot`, and `test/e2e/managed-operations.test.ts` with 7 tests against the compiled binary. Recovery runs before the endpoint is published, so the first snapshot a client sees already describes what the previous core was doing. The snapshot is synchronous while the record lives on a shared disk, so the wiring keeps an in-memory view refreshed on startup and on every change this core makes. `provisionerFor` returns null on every platform because no host recipe is qualified yet: an environment reports itself unsupported and a setup fails with an actionable blocker rather than appearing to install something. The e2e points `ATOMIC_CORE_MANAGED_ROOT` at a scratch directory so it never touches the real per-user environment. Not covered here and belonging to T24a: a restart in the middle of a running operation, which needs a fake provisioner the compiled binary can be given.

**Repository:** CORE. **Depends on:** T05b.
**Files:** `src/core/{create,atomic-core}.ts`; new `test/e2e/managed-operations.test.ts`.
**Implement:** attach the service to the core lifecycle; expose snapshots and events after recovery.
**Acceptance:** compiled fake-backed core survives restart mid-operation; snapshot + SSE rebuilds the
operation; old instance events cannot resurrect state.

## T06 — Docker command execution

### T06a — Define executor types and pure Docker argv

**Repository:** CORE. **Depends on:** T01a, T01c.
**Files:** new `src/runtime/container/{index,types,args}.ts` and test.
**Implement:** `ContainerExecutor` types and validated argv builders: explicit socket, pinned digest,
`--restart=no`, loopback publish, bounded `--shm-size`, `--gpus device=<id>`, read-only entrypoint
and model mounts, writable cache and heartbeat mounts. No shell.
**Acceptance:** metacharacter paths remain one argv item; socket or escaping mounts rejected;
ambient context irrelevant; no `latest`, no wildcard publish.

### T06b — Implement bounded process I/O and cancellation

**Repository:** CORE. **Depends on:** T06a.
**Files:** new `src/runtime/container/process.ts`; fake executable under `test/helpers/`.
**Implement:** run argv with injected spawn, bounded output, timeout, AbortSignal; distinguish CLI
termination from container termination.
**Acceptance:** partial JSON, oversized output, hung process return typed failures; killing the CLI
never reports the container stopped.

### T06c — Implement inspect/create/start/stop/remove and the GPU test

**Repository:** CORE. **Depends on:** T06b.
**Files:** new `src/runtime/container/docker.ts` and test.
**Implement:** lifecycle, digest pull with progress, `probe` including the `--gpus` test container,
inspect verifying engine ID and full container ID, `StopEvidence` only after verified exit or
absence, `touchHeartbeat`.
**Acceptance:** wrong daemon or reused ID cannot be stopped; failed inspect is not absence; timeout
retains ownership; GPU test failure reported distinctly from daemon unreachable.

## T07 — container journal and heartbeat watchdog

### T07a — Persist the container authority journal

**Repository:** CORE. **Depends on:** T02a, T06c, T01c.
**Files:** new `src/runtime/container/journal.ts`; `src/lock/process-journal.ts` if wiring needs it.
**Implement:** full execution identity in the scope's `executions/`; native journal still readable;
journal before exposing a session.
**Acceptance:** old native record loads; mismatched container record cannot authorize a kill; two
engines with the same model name stay distinct.

### T07b — Ship the entrypoint watchdog script and heartbeat writer

**Repository:** CORE+APP. **Depends on:** T07a.
**Files:** new CORE `src/runtime/container/watchdog.ts`, `assets/managed-entrypoint.sh`; APP bundle
scripts including the script as a verified resource.
**Implement:** POSIX shell entrypoint per the contract (child `trtllm-serve`, heartbeat mtime poll,
TERM then KILL, exit with child status); core-side periodic `touchHeartbeat` per live session;
digest recorded in the descriptor.
**Acceptance:** script tested with a fake child under `sh`: stale heartbeat kills within the limit,
fresh heartbeat never kills, child exit propagates status; core stops touching after unload.

### T07c — Prove orphan recovery and watchdog exit on real hosts

**Repository:** CORE. **Depends on:** T07b, T03c. **Host:** Ubuntu 4070; Windows in T09g.
**Files:** `src/core/create.ts` recovery/shutdown; live test; evidence doc.
**Implement:** reconcile recorded containers on startup; kill the owner core during an active model.
**Acceptance:** container exits after the stale limit and VRAM recovers; foreign containers untouched.

## T08 — Linux provisioning: adopt or install system Docker

### T08a — Parse Linux prerequisite facts without mutation

**Status:** done 2026-09-22. New `src/runtime/environment/linux-probe.ts` + 16 tests. Reads distribution, driver and cards, Docker CLI and daemon, whether the daemon can reach a GPU (an `nvidia` runtime or a CDI spec directory), group membership and whether this session already has it, toolkit, and free disk. A host that already runs containers on its GPU is reported as adoptable, which is what lets setup ask for no password at all. Every probe that could not be read lands in `unknown` and blocks, rather than being assumed present. The container GPU test is deliberately not run here: it pulls an image, so it belongs to provisioning and is reported as not-run.

**Repository:** CORE. **Depends on:** T01a.
**Files:** new `src/runtime/environment/linux-probe.ts` and tests.
**Implement:** driver, Docker CLI/daemon, group membership and effectiveness, Toolkit presence, GPU
test result, disk, distribution/version through injected commands.
**Acceptance:** fixtures for clean, Docker-without-Toolkit, working-GPU-Docker and unsupported
distribution; unknown probe is a blocker; existing daemon recorded as adoptable or not.

### T08b — Build the Linux requirement plan

**Repository:** CORE. **Depends on:** T08a, T03c, T01b.
**Files:** new `src/runtime/environment/linux-plan.ts` and tests.
**Implement:** from facts produce either an adopt plan (no host step) or the enumerated
`linux.install-container-runtime` step with the pinned package set and listed system changes;
approval hash; `may_require_relogin`.
**Acceptance:** same facts same plan; working GPU Docker -> adopt without helper; changed recipe
invalidates approval; unsupported distribution -> blocker with instructions.

### T08c — Implement the bundled pkexec helper

**Repository:** APP. **Depends on:** T08b, T01d.
**Files:** new `src-tauri/src/core/runtime_setup/{mod,linux}.rs`; helper binary target in
`src-tauri/src/bin/` and `Cargo.toml`; Linux bundle scripts.
**Implement:** validate HostStep, nonce, revision and digests; invoke the helper through `pkexec`;
the helper performs only the pinned recipe (repositories and keys, packages, `nvidia-ctk runtime
configure`, service enable/start, `usermod -aG docker <original user>`), removes nothing, returns
`completed` or `relogin-required`.
**Acceptance:** wrong nonce/revision/hash denied before elevation; declined `pkexec` -> `declined`;
fake package manager exercises interruption at a safe boundary; helper cannot run arbitrary argv.

### T08d — Verify and adopt the environment as the normal user

**Repository:** CORE. **Depends on:** T08b, T08c, T05a, T06c.
**Files:** new `src/runtime/environment/linux-provision.ts`; platform factory wiring.
**Implement:** after a receipt re-probe; wait in `relogin-required` until the group is effective;
run the GPU test; record the engine identity; adopt a passing preexisting engine unchanged.
**Acceptance:** fake failures at each step resume without duplicates; helper claiming success with
unmet facts rejected; preexisting engine reused with zero mutations.

### T08e — Run packaged Linux provisioning acceptance

**Repository:** CORE+APP. **Depends on:** T08d, T05c, T07b. **Host:** Ubuntu 4070.
**Files:** live installer harness; evidence doc.
**Implement:** exercise the packaged helper and core setup from a minimal app harness on clean
Ubuntu, Ubuntu with Docker only, and Ubuntu with working GPU Docker.
**Acceptance:** no terminal; denial, low disk, interrupted install and sign-out continuation
recover; existing containers survive.

## T09 — Windows WSL provisioning and guest transport

### T09a — Parse Windows virtualization, WSL and user facts

**Status:** done 2026-09-22. New `src/runtime/environment/windows-probe.ts` + 18 tests. Reads WSL features, firmware virtualization, the distribution inventory, driver and cards, and free disk. Two traps are handled here: `wsl.exe` writes UTF-16, so output decoded as UTF-8 carries a NUL between every character and parses as zero distributions on a machine that has several; and the invoking account is supplied by the app rather than read from the process, so an elevation running as an administrator never becomes the identity the distribution is imported under. A distribution is ours only when its name is the exact one this installation recorded, never a family resemblance.

**Repository:** CORE. **Depends on:** T01a.
**Files:** new `src/runtime/environment/windows-probe.ts` and tests.
**Implement:** features, virtualization, original user, distribution inventory, driver, disk through
injected commands; owned vs foreign registrations.
**Acceptance:** missing virtualization/WSL reported; alternate-admin identity never replaces the
original user; no change during probe.

### T09b — Implement the Windows feature-enable helper

**Repository:** APP. **Depends on:** T09a, T01d.
**Files:** new `src-tauri/src/core/runtime_setup/windows.rs`; helper target; signing scripts.
**Implement:** UAC entry for `windows.enable-wsl` only; common receipt validation; never register
the guest as administrator.
**Acceptance:** fake bridge rejects arbitrary command and stale receipt; helper builds and signs.

### T09c — Implement persisted reboot continuation

**Repository:** CORE+APP. **Depends on:** T09b, T04c, T05c.
**Files:** new CORE `src/runtime/environment/windows-plan.ts`; APP startup handoff.
**Implement:** persist `reboot-required`, re-probe at next launch, resume the same operation;
changed plan asks fresh consent.
**Acceptance:** simulated close/reboot uses the same operation ID; old nonce cannot re-enable.

### T09d — Import and reconcile the owned WSL distribution

**Repository:** CORE. **Depends on:** T09c, T03d, T06b.
**Files:** new `src/runtime/environment/wsl-import.ts`; owned-distro identity store.
**Implement:** `wsl.exe --import` under the original user with a hash-verified base tarball;
explicit systemd configuration; registration recorded in the shared root.
**Acceptance:** Unicode args; crash after import finds the exact owned distribution; name collision
refuses adoption; failed hash prevents import.

### T09e — Implement the bounded guest command and file transport

**Repository:** CORE. **Depends on:** T09d, T07b.
**Files:** new `src/runtime/container/wsl.ts`; guest file helpers.
**Implement:** `wsl.exe -d <distro> --exec` with fixed argv for docker commands, mkdir/stat/rename/
remove within bounded guest paths, streaming file writes for downloads; heartbeat path selection
(automount vs `--exec touch`) from T03d measurements.
**Acceptance:** path escape and wrong distribution denied; host CLI death is not container exit;
loopback target resolved explicitly; oversized output bounded.

### T09f — Provision guest Docker and verify the environment

**Repository:** CORE. **Depends on:** T09e, T03d, T05a.
**Files:** new `src/runtime/environment/wsl-provision.ts`; platform factory.
**Implement:** pinned guest Engine/Toolkit recipe, systemd verification, GPU test in the guest, owned
storage layout; no Linux display driver, no Docker Desktop.
**Acceptance:** fake interruption resumes each guest step; no duplicate model copy; host/guest paths
retained.

### T09g — Run Windows helper, reboot and watchdog acceptance

**Repository:** CORE+APP. **Depends on:** T09f, T05c, T07b. **Host:** Windows 4070.
**Files:** Windows live harness; evidence doc.
**Implement:** real UAC including alternate admin credentials, original-user import, restart and
resume, guest GPU, watchdog expiry after killing the core.
**Acceptance:** clean Windows and existing-distribution hosts pass; denial and partial import
recover; core death frees the GPU; no foreign distribution or admin-owned import.

## T10 — withdrawn

Session gateway removed by the 2026-09-22 decision: no request accounting; callers reach the
session's loopback port directly.

## T11 — GPU residency rule

### T11a — Implement the pure residency policy

**Status:** done 2026-09-22. New `src/core/gpu/{index,policy}.ts` + 14 tests. GPU01-GPU04 pass. The container stop proof carries the execution id and the observed state rather than T06a's whole `StopEvidence`, so this module does not depend on `src/runtime/container`; the lifecycle converts one into the other. Reservation ids are injected. The contract document was amended for both.

**Repository:** CORE. **Depends on:** T01a.
**Files:** new `src/core/gpu/{index,policy}.ts` and test.
**Implement:** `ResidencyPolicy` per the contract: one resident local GPU model per GPU,
`evictionsFor`, reservation held until stop proof, generation validation, CPU sessions exempt.
**Acceptance:** GPU01-GPU04.

### T11b — Apply the rule to every local runtime

**Repository:** CORE. **Depends on:** T11a, T02c.
**Files:** `src/core/sessions.ts`; `src/runtime/shared/local-runtime.ts`;
`src/runtime/llamacpp/runtime.ts`; `src/runtime/mlx/runtime.ts`; `src/diffusion/{session,jobs,idle}.ts`;
`src/server/public/ctx.ts`.
**Implement:** the session owner asks `evictionsFor` before any local GPU load, stops listed sessions
through their runtimes regardless of activity, waits for confirmed exit, reserves, then loads.
Native auto-unload, context recreate, diffusion idle unload and shutdown confirm stops through the
same path. `bypassAutoUnload` keeps its meaning within a provider but never bypasses the rule.
**Acceptance:** TensorRT-shaped fake load stops a generating sd.cpp fake and an idle llama.cpp fake;
llama.cpp CUDA load stops a container fake; CPU llama.cpp untouched; failed native exit keeps the
reservation; existing llama.cpp/MLX/diffusion suites pass.

## T12 — withdrawn

Caller migration through the gateway removed. Consumer session-type changes moved to T02b; image
reservation hooks moved to T11b.

## T13 — model resolution, artifacts and download

### T13a — Implement immutable artifact inventory and references

**Status:** done 2026-09-22. New `src/models/{snapshot-plan,artifact-references}.ts` + 26 tests. Identity is repository, revision, file inventory and storage domain, hashed into a fixed-length directory name with readable provenance written beside the bytes; a revision whose files changed under it is a different artifact, and the native and guest domains never dedupe into each other. References are kept by reason rather than counted, and a delete states the revision it was decided on, so a checkpoint loaded while the caller was deciding cannot be removed. Compatibility is deliberately not part of identity.

**Repository:** CORE. **Depends on:** T01b, T01c.
**Files:** new `src/models/{snapshot-plan,artifact-references}.ts`.
**Implement:** immutable repo/revision/inventory/storage-domain identity separate from engine
compatibility; atomic retained/installation/live references; private cache keys.
**Acceptance:** same revision differing inventory not deduplicated; native/guest domains separate;
remove-last-reference race cannot delete a live artifact.

### T13b — Implement staged snapshot downloading

**Repository:** CORE. **Depends on:** T13a.
**Files:** new `src/models/snapshot-download.ts`; `src/downloads` helpers; registry integration.
**Implement:** download the complete inventory with resumable staging, verification and an atomic
ready marker; injected native/guest file transport; gated credentials in the core.
**Acceptance:** fixture server covers range resume, corruption, missing shard, auth, low disk,
cancellation; incomplete artifact never registered; GGUF imports unchanged.

### T13c — Connect guest storage and registry readiness

**Repository:** CORE. **Depends on:** T13b, T09e.
**Files:** guest transport adapter; `src/models/{registry,model-yml}.ts`.
**Implement:** guest downloads through the bounded transport; typed locations persisted; API model
ID kept separate.
**Acceptance:** guest path never opened as a Windows path; disconnect resumes; two fake engines
share one snapshot while caches stay separate.

### T13d — Implement Hugging Face resolution and compatibility

**Repository:** CORE. **Depends on:** T13a, T01b, T03c.
**Files:** new `src/models/managed-resolve.ts`; `src/models/hf.ts`; control route `resolve`.
**Implement:** fetch repository file list, sizes, `config.json` and `quantization_config`; compute
`ModelResolution` against the descriptor (architectures, quantization matrix, compute capability,
weight bytes + KV reserve vs free VRAM); curated list filtered the same way and grouped by tier.
**Acceptance:** unsupported architecture, NVFP4 on a sm89 fixture, oversized weights and GGUF-only
repositories refused with the reason and numbers before any weight download; gated repository
reported; supported FP8 on sm89 accepted.

## T14 — TensorRT text LocalRuntime and core wiring

### T14a — Implement the compiled adapter registry

**Repository:** CORE. **Depends on:** T01b.
**Files:** new `src/runtime/managed-text/{index,adapter,registry}.ts`.
**Implement:** contract declarations, capability lookup, explicit registry; two fake adapters in tests.
**Acceptance:** unknown adapter unavailable; mismatched version rejected; descriptor cannot execute
code; per-adapter route policies stay separate.

### T14b — Implement the generic managed-text lifecycle

**Repository:** CORE. **Depends on:** T14a, T06c, T07b, T11b, T05c, T13b.
**Files:** new `src/runtime/managed-text/lifecycle.ts`.
**Implement:** artifact validation, residency eviction and reservation, create/journal/start/
heartbeat/readiness, session publication with loopback `host:port`, stop with confirmed exit.
No TensorRT conditionals.
**Acceptance:** cancel at every boundary, readiness failure and failed stop preserve journal and
reservation; two fake adapters follow the same lifecycle; heartbeat stops after unload.

### T14c — Implement the TensorRT adapter

**Repository:** CORE. **Depends on:** T14a, T03c.
**Files:** new `src/runtime/tensorrt-llm/{index,adapter,args}.ts`.
**Implement:** `trtllm-serve` argv from the tested release (`--backend pytorch`, `--host 0.0.0.0`
inside the container, `--port`, `--max_seq_len`, `--kv_cache_free_gpu_memory_fraction`, model
mount path); readiness through `/health` and `/v1/models`; API policy (chat, completions,
responses, metadata); settings validation; resource estimate from weight bytes.
**Acceptance:** exact argv fixture; invalid settings rejected before spawn; readiness distinguishes
starting from failed.

### T14d — Register the TensorRT LocalRuntime

**Repository:** CORE. **Depends on:** T14b, T14c, T13d.
**Files:** new `src/runtime/tensorrt-llm/runtime.ts`; `src/contracts/session.ts`; `core/create`,
`router/resolve`, `config/paths`, settings provider maps.
**Implement:** provider ID and exhaustive map entries; delegate `LocalRuntime` to the generic
lifecycle; `autoIncreaseCtx` returns `unsupported`; gate on environment and descriptor readiness.
**Acceptance:** compiled fake-backed core load/cancel/unload/recreate and public chat pass; missing
environment reports `setup-required`; native models unchanged; no vLLM/SGLang registration.

### T14e — Prove the first real managed chat lifecycle

**Repository:** CORE. **Depends on:** T14d, T07c, T08e. **Host:** Ubuntu 4070.
**Files:** live test; evidence doc.
**Implement:** run a curated FP16 model and an FP8 checkpoint through the real environment.
**Acceptance:** stream, cancel, reload, verified unload with VRAM recovered; no residual container.

## T15 — app extension and local provider

### T15a — Build the thin TensorRT app extension

**Repository:** APP. **Depends on:** T02c, T14d.
**Files:** new `extensions/atomic-tensorrt-llm-extension/`; `extensions/shared/atomicCoreRuntime.ts`.
**Implement:** core-backed model list, settings, load/unload, fresh session lookup. No process or
Docker code in the extension.
**Acceptance:** fake relay records provider and cancel; stale session refreshed; unsupported host
error surfaced; bundle builds with no new runtime dependency.

### T15b — Register the app local provider and Agent selection

**Repository:** APP. **Depends on:** T15a, T02b.
**Files:** `web-app/src/constants/providers.ts`; local provider services;
`src-tauri/src/core/agent/target.rs`; extension discovery scripts.
**Implement:** gated provider, settings and model selection; explicit local Agent classification;
old tarball names preserved.
**Acceptance:** TensorRT routes locally with the public listener off; unsupported host unavailable;
no cloud registry entry; extension discovered by the app build.

## T16 — app environment client and store

### T16a — Add the typed environment relay client

**Repository:** APP. **Depends on:** T01d, T05b.
**Files:** new `web-app/src/services/managed-runtime.ts`; `src-tauri/src/core/atomic_core/commands.rs`
for the validated host bridge only.
**Implement:** wrap `atomic_core_call` for the environment and resolve routes with typed errors.
**Acceptance:** 400/409 fields preserved; Unicode ID encoded once; host-step payload cannot choose a
command; token absent from JS.

### T16b — Implement the per-installation store

**Repository:** APP. **Depends on:** T16a, T05c.
**Files:** new `web-app/src/stores/managed-runtime-store.ts`; `relay.rs` for full-state events.
**Implement:** environment, GPU facts, per-engine installation state and model resolutions from
snapshot and current-instance events; no local install truth.
**Acceptance:** older revision discarded; two engines independent; unmount does not cancel;
reconnect restores the pending operation.

## T17 — text setup dialog and entry points

### T17a — Render the setup-step presentation

**Repository:** APP. **Depends on:** T16b.
**Files:** new `web-app/src/containers/dialogs/ManagedRuntimeSetupDialog.tsx` and helpers.
**Implement:** requirements, progress, approval, sign-out, restart, error and ready fixtures with
engine-name parameters; model picker with curated tiers and a repository input showing the verdict.
**Acceptance:** every phase renders the correct actions; unknown bytes indeterminate; close is not
success; incompatible model shows the reason and cannot be downloaded.

### T17b — Wire setup actions and helper handoff

**Repository:** APP. **Depends on:** T17a, T08c, T09b.
**Files:** new `web-app/src/hooks/useManagedRuntime.ts`; `runtime_setup` handoff registration.
**Implement:** install/approve/cancel/resume/retry bound to the store and helpers; concrete system
changes before consent; `relogin-required` and `reboot-required` guidance.
**Acceptance:** changed plan needs renewed consent; double click one operation; helper decline
surfaced; reopen retains state without repeating the prompt.

### T17c — Add chat/settings entry points and localization

**Repository:** APP. **Depends on:** T17b, T15b.
**Files:** model selection callers; `web-app/src/routes/settings/providers/`; locales.
**Implement:** open the dialog from a compatible model or provider settings and return to origin;
only TensorRT offered.
**Acceptance:** ready environment skips preparation; no implicit download, license acceptance or
provider switch; Images UI unchanged.

## T18 — staged update, rollback and scoped removal

### T18a — Implement per-installation staged updates

**Repository:** CORE. **Depends on:** T05c, T14b.
**Files:** new `src/runtime/environment/update.ts`; service wiring.
**Implement:** stage, verify, unload resident via the rule, smoke with the selected model, commit,
retain the previous descriptor.
**Acceptance:** OP06; crash around activation reconciles one active digest; failed candidate leaves
the prior model runnable.

### T18b — Implement scoped removal

**Repository:** CORE. **Depends on:** T18a, T13a, T07a.
**Files:** new `src/runtime/environment/remove.ts`; reference transaction.
**Implement:** stop the target runtime, verify exit, unlink its resources, honor retained models;
refuse environment deletion while referenced; never prune globally.
**Acceptance:** OP07; failed stop keeps the journal; last explicit deletion removes only owned bytes.

## T19 — data move/reset guards and exit recovery

### T19a — Guard data-folder move

**Repository:** APP. **Depends on:** T05b, T16a.
**Files:** `src-tauri/src/core/app/commands.rs`; move tests.
**Implement:** quiesce managed sessions before a move; move scope artifacts and caches; the shared
environment is not moved; refuse when the core is unavailable.
**Acceptance:** move with a resident model stops it first; no-environment move unchanged; guest
artifacts on Windows are not copied as Windows paths.

### T19b — Coordinate reset and full-exit recovery

**Repository:** CORE+APP. **Depends on:** T18b, T07c, T09g.
**Files:** CORE shutdown/recovery; APP `src-tauri/src/core/system/commands.rs`; supervisor exit path.
**Implement:** reset uses targeted removal before deleting authority records; full exit stops owned
containers; tray keeps them; CLI independent.
**Acceptance:** interrupted reset cannot orphan a container without a journal; exit vs tray differ;
restart reconciles old identities.

## T20 — runtime catalog reading and publication validation

### T20a — Implement descriptor fetch and cache

**Repository:** CORE. **Depends on:** T01b.
**Files:** new `src/runtime/environment/catalog.ts`; tests.
**Implement:** fetch the runtime manifest over HTTPS from conf, validate, cache the last accepted
copy, serve it offline; minimum core/app version gating. No signature (deferred).
**Acceptance:** malformed update never replaces a valid cache; offline uses the cache; newer
minimum versions hide the install button with a message.

### T20b — Add CONF schema and publication validation

**Repository:** CONF. **Depends on:** T20a, T03c, T03d.
**Files:** new `runtimes/` manifest and schema; validation workflow.
**Implement:** the same schema as CORE, digest/platform uniqueness, evidence references.
**Acceptance:** schema fixtures match CORE; missing digest or evidence blocks publication.

## T21 — package the paired release candidate

### T21a — Package core artifacts

**Repository:** CORE. **Depends on:** T14d, T07b, T09e, T20a.
**Files:** build/version scripts; artifact manifest.
**Implement:** core binaries, entrypoint script digest, protocol identity for all targets.
**Acceptance:** tampered script rejected; targets and hashes recorded.

### T21b — Package the Linux candidate

**Repository:** APP. **Depends on:** T21a, T08e, T15b, T17c, T18b, T19b, T20b, T24c.
**Files:** Linux bundle scripts, helper target, capabilities, core pin, extension discovery.
**Implement:** matched core, helper, entrypoint script and extension; future engines unavailable.
**Acceptance:** fresh launch discovers the extension; version mismatch refused; `pkexec` of the
bundled helper works from the installed location.

### T21c — Package the Windows candidate

**Repository:** APP. **Depends on:** T21a, T09g, T15b, T17c, T18b, T19b, T20b, T24c.
**Files:** Windows bundle/sign scripts, helper target, shared pins.
**Implement:** matched Windows candidate; serialize shared pin edits with T21b.
**Acceptance:** fresh install finds helpers and extension; signatures verified; missing signing
input declared, not silently unsigned.

## T22 — release acceptance on both OSes

### T22a — Run Linux product acceptance

**Repository:** CORE+APP. **Depends on:** T21b, T14e. **Host:** Ubuntu 4070.
**Implement:** full dialog through curated and pasted models, chat, Agent, API, stream, cancel,
model switch during generation, update, rollback, remove, restart, reset/move on clean and
existing-Docker Ubuntu.
**Acceptance:** artifact and model IDs logged; no terminal, foreign mutation or leaked container.

### T22b — Run Windows product acceptance

**Repository:** CORE+APP. **Depends on:** T21c. **Host:** Windows 4070.
**Implement:** the same flows plus UAC denial, alternate admin, reboot, guest networking/storage
failures.
**Acceptance:** resume after reboot under the original user; GPU reclaimed after crash; foreign
distributions untouched.

### T22c — Assemble release evidence without publishing

**Repository:** CORE+APP. **Depends on:** T22a, T22b, T03e.
**Files:** `docs/testing-critical-flows.md`; release evidence; artifact list.
**Implement:** reconcile both OS results, 5090 results, regressions, metadata and rollback.
**Acceptance:** no critical case marked passed without a result; limitations explicit; binaries,
core pin and catalog agree.

## T23 — withdrawn

Separate NVFP4 qualification merged into T03e (evidence) and T13d (compute-capability filter).

## T24 — prove shared infrastructure with two fake engines

### T24a — Prove the common lifecycle with two fake adapters

**Repository:** CORE. **Depends on:** T14b, T18b, T20a.
**Files:** new `test/e2e/managed-text-engines.test.ts`; fixture adapters.
**Implement:** install A and B in one fake environment with different launch/API policies; update
and remove A while B remains; drive real core routes with fake Docker.
**Acceptance:** one host preparation, distinct digests and caches, OP07 and GPU traces; adding B
changes no shared production module.

### T24b — Prove shared-artifact ownership under contention

**Repository:** CORE. **Depends on:** T24a, T13c.
**Implement:** concurrent references, retained bytes, same basename across providers, cancellation
during last-reference deletion; native/guest separate.
**Acceptance:** shared bytes survive removal of A while B owns them; deletion cannot race a new
reference; wrong provider session never targeted.

### T24c — Prove independent setup UI state for two engines

**Repository:** APP. **Depends on:** T24a, T24b, T17c.
**Implement:** two fake installations through the shared UI: sibling readiness, independent update
failure, one shared environment.
**Acceptance:** A ready does not imply B ready; retry targets only B; no real vLLM/SGLang entry.

## Future engine onboarding (not current assignments)

Each of `vllm` and `sglang` adds a descriptor with its own supported-architecture and quantization
tables, `src/runtime/<engine>/adapter.ts`, core registration, an app extension and its own live
tests. TensorRT's tables and evidence do not transfer.

## Copyable first coding prompt

> Implement T01a from docs/decisions/2026-09-22-sequence-tensorrt-llm-agent-tasks.md in Atomic-Chat.
> The edit repository for T01a is the sibling atomic-chat-core on branch feat/tenzor-rt. Read its
> AGENTS.md and the linked coding-contract document. Deliver the wire types/events/error codes and
> adjacent tests only. Do not implement the rest of parent T01 or change APP fixtures yet. Preserve
> unrelated work. No new dependencies, commits, publishing or host provisioning. Run focused tests
> and CORE npm run verify; report pre-existing toolchain failures separately. Hand off the exact
> changed files, passing/failing commands and remaining acceptance items.

### Required handoff form

- Child ID and base revisions in each edited repository.
- Implemented behavior and files; links to code and tests.
- Acceptance cases exercised, commands and results; OS for platform/runtime tests.
- Persisted or wire changes and compatibility effects.
- Unfinished checks or external inputs.
- Dependents newly unlocked; do not start them automatically.

## Coverage and known release inputs

71 child assignments. Parent coverage: W0 -> T03; W1 -> T01-T02, T20; W2 -> T04-T05; W3 -> T06-T07;
W4-L/W -> T08-T09; W5 -> T11; W6 -> T13-T15; W7 -> T16-T17; W8 -> T18-T19; W9 -> T03e + T13d;
W10 -> T21-T22; shared-engine proof -> T24.

Remaining external inputs: SSH or console access to the Ubuntu 4070 and Windows 4070, the 5090 when
it arrives, package pins from T03, release signing keys, a writable CONF checkout.
