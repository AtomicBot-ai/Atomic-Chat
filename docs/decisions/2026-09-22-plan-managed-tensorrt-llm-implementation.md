---
date: 2026-09-22
title: "Plan managed TensorRT-LLM implementation"
status: proposed
---

# Managed TensorRT-LLM: implementation plan

**2026-09-23 amendment:** Read the
[deployment-boundary handoff](2026-09-23-preserve-containerized-core-deployment-seams.md)
before continuing the affected cards. It preserves future containerized-core deployment through
internal seams only; server delivery remains deferred. Completed wire/storage contracts and
desktop behavior remain in force.

For coding assignments use the [executable agent backlog](2026-09-22-sequence-tensorrt-llm-agent-tasks.md).
It splits these work packages into 72 child tasks (71 live; T01d withdrawn) under parent labels T00-T24 (T10, T12 and T23
withdrawn). Dispatch a lowercase-suffix child ID, not a whole parent. Exact interfaces and
transition tests are in the [coding contracts](2026-09-22-specify-managed-runtime-coding-contracts.md).

- **Context:** The [architecture](2026-09-22-propose-managed-tensorrt-llm-architecture.md) and
  [functional specification](2026-09-22-specify-managed-tensorrt-llm-flows.md) define the intended
  behavior after the product decisions of 2026-09-22. This document orders implementation across
  the core, the desktop app and release metadata.
- **Proposed decision:** Qualify the runtime on the available 4070 hosts first, build durable
  environment management and container ownership, then deliver one-click chat setup on Windows and
  Linux as equal targets. Verify NVFP4 on the 5090 as soon as it is available.
- **Consequences:** Contracts need paired core/app releases. A successful inference demo is an
  intermediate milestone; interruption recovery, uninstall and upgrade are required before release.
- **Owner:** the operator with coding agents, one child task at a time.

## 0. Progress

As of the 2026-09-23 amendment: 19 of 71 live child tasks done. T01e is new and pending;
T01d remains withdrawn into T16a. Existing completion evidence is retained from 2026-09-22. Per-child status and
evidence live in the [backlog](2026-09-22-sequence-tensorrt-llm-agent-tasks.md); this table only
rolls them up. W9 shares T03e with W0 and T13d with W6.

| Package | Children | Done | State |
| ------- | -------- | ---- | ----- |
| Toolchain baseline | T00 | 2/2 | done: CORE verify green; APP `make verify` stops only at a pre-existing test-quality guard |
| W0 — qualify runtime and provisioning | T03 | 1/5 | in progress: inventory harness done (T03a) and first run on the Ubuntu 4070; experiment runner and hardware evidence pending |
| W1 — contracts, identities, metadata | T01-T02, T20 | 6/9 | contracts, descriptor parsing, data paths, nullable-PID sessions and control protocol 2 done; deployment seams (T01e), descriptor fetch and CONF validation (T20) pending |
| W2 — durable environment operations | T04-T05 | 6/6 | done: reducer, CAS store, recovery, service, control routes, startup wiring and SSE; a restart mid-operation against the compiled binary is left to T24a |
| W3 — container executor and watchdog | T06-T07 | 0/6 | not started |
| W4-L — Linux provisioning | T08 | 1/5 | host probe done (T08a); plan, pkexec helper, adoption and acceptance pending |
| W4-W — Windows WSL provisioning | T09 | 1/7 | host probe done (T09a); helper, reboot continuation, import, transport and acceptance pending |
| W5 — residency rule | T11 | 1/2 | pure policy done (T11a); applying it to every local runtime (T11b) pending |
| W6 — chat provider and model acquisition | T13-T15 | 1/11 | immutable artifact identity and references done (T13a); download, resolution, adapter, runtime and app extension pending |
| W7 — setup presentation | T16-T17 | 0/5 | not started |
| W8 — update, removal, storage, shutdown | T18-T19 | 0/4 | not started |
| W9 — NVFP4 on the 5090 | T03e, T13d | 0/2 | waiting for the card |
| W10 — package and publish | T21-T22 | 0/6 | not started |
| Shared-engine proof | T24 | 0/3 | not started |

Milestones: M0 has started; M1 has its contract and operation layers (W1 mostly, W2 fully) but
not the executor, installers or runtime integration of the residency rule; M2-M4 have not started.

## Amendment dispatch order

Complete **T01e** before T06a and T14a. It adds private runtime interfaces and desktop projection
checks without reopening completed T01-T05 cards. Other independent pending tasks keep their
existing dependencies. T06/T07/T13/T14/T19/T24 carry the integration and acceptance work; server
packaging, supervisor transport, named volumes and new public session types are not assignments.
See the [handoff](2026-09-23-preserve-containerized-core-deployment-seams.md) for exact changes, reasons and preserved contracts.

## 1. Scope and delivery boundaries

Prepare for vLLM and SGLang per the [shared managed-text infrastructure](2026-09-22-share-managed-text-runtime-infrastructure.md)
decision: generic environment/execution/model/UI layer plus the TensorRT adapter. T24 proves the
extension boundary with two fake engines before packaging.

Text inference only. Image generation is touched only by the residency rule.

Release baselines: Windows 11 x64 with WSL2 and Ubuntu 24.04 x86_64 with systemd, any NVIDIA GPU
the engine drives (Ampere and newer), any model whose architecture the release implements and whose
weights fit the card. Atomic Chat performs setup; the user sees requirements, one OS authorization
prompt and, when needed, a sign-out or restart. No terminals, Docker contexts or Python.

For this desktop release, the native core owns operations, downloads, containers, models and the
residency rule. Shared lifecycle code receives deployment services; native OS selection belongs
to the desktop composition layer. Windows runs
the pinned Linux image in an owned WSL distribution; Linux uses the system Docker Engine, adopted
or installed. The environment is shared per machine user by the app and CLI cores; sessions and
model artifacts stay per scope. The public OpenAI-compatible API at `localhost:1337/v1` forwards to
the session like it does for llama.cpp.

Work spans three repositories:

- **atomic-chat-core:** contracts, environment service, execution, model resolution and download,
  providers, residency rule and lifecycle tests.
- **Atomic-Chat:** engine extension, model/provider UI, setup UI, Rust consumers, privileged helpers
  and packaging; consume a tested core release and shared fixtures.
- **atomic-chat-conf:** the runtime descriptor (image digest, requirements, supported
  architectures, quantization matrix, curated models), served over HTTPS like the llama.cpp manifest.
  The first hardware experiment uses a pinned local descriptor.

## 2. Milestones and order

1. **M0 — feasibility evidence:** W0 on the Ubuntu 4070 and the Windows 4070 in parallel; the 5090
   pass for NVFP4 when the card arrives.
2. **M1 — managed execution foundation:** W1-W4 provide durable setup, container ownership, both
   platform installers; W5 the residency rule. W4-L and W4-W proceed in parallel after W1-W3.
3. **M2 — developer vertical slice:** W6 and W7 connect model resolution, download, setup and chat
   in the app on the first qualified host.
4. **M3 — first release:** W8 and W10 pass on both OSes. Windows and Linux ship together.
5. **M4 — NVFP4 evidence:** W9 on the 5090; it gates the compute-capability filter's correctness,
   not the release of FP16/FP8 chat.

## 3. Work packages

### W0 — qualify the runtime and provisioning assumptions

**Owner:** core investigation on the available hosts (Ubuntu 4070, Windows 4070, later 5090).

- Inventory OS, GPU compute capability and VRAM, driver, RAM/disk, virtualization, existing
  Docker/WSL and active workloads before changing shared host state.
- Pull `1.3.0rc27` by digest; verify embedded metadata. Pin one small FP16/BF16 chat model that fits
  12 GB and one NVIDIA FP8 checkpoint. Measure startup, first token, streaming, cancel, unload,
  VRAM recovery, disk use, warm restart, watchdog kill.
- Linux: adopt the host's Docker if present, otherwise perform the exact helper recipe by hand and
  record package versions. Windows: import a distribution, configure systemd, install guest Docker
  and Toolkit, verify GPU inside the guest and loopback reachability from Windows.
- Choose shared-memory size, heartbeat interval and stale limit from measurements.
- 5090: NVFP4 checkpoints, the rc27 SM120 known issue, memory and cancellation.

**Exit evidence:** reproducible commands, exact image/model/package identities, results and logs
per OS. A 4070 result does not cover NVFP4; the 5090 result does not cover the installer.

### W1 — freeze contracts, identities and release metadata

**Owner:** core + app. **Dependencies:** architecture; W0 informs the quantization matrix.

- Separate shared environment, per-engine installations and per-scope immutable artifacts.
- Add environment/operation contracts: probe, begin, get, cancel, resume, host receipt, model
  resolution; idempotency, errors, durable operation ID, progress events, snapshot/SSE reconciliation.
- Replace mandatory host PID with typed execution kind and nullable PID; bump the control protocol
  as one paired change.
- Descriptor schema with digest/platform, recipes, minimum versions, compute-capability floor,
  supported architectures, quantization matrix, curated models, notices and exclusions.
- Publish paired fixtures before changing consumers.

**Exit evidence:** matching TS/Rust fixtures; old/unknown version behavior; invalid identity tests.

### W2 — build durable environment operations

**Owner:** core. **Dependencies:** W1.

- Environment service with a pure reducer, CAS store in the shared root with a cross-core file
  lock, inventory-based recovery and injected host operations.
- Phases through consent, host preparation, sign-out or reboot continuation, environment creation,
  pull, verification and ready; cancel/resume/retry; stable failure codes.

**Exit evidence:** fake host/executor tests interrupt every mutation boundary; repeated resume never
duplicates resources; consent denial and `relogin-required` preserve recoverable state; snapshot
reconnect works after UI and core restart; two cores cannot interleave writes.

### W3 — implement the container executor and watchdog

**Owner:** core, with the entrypoint script packaged by the app. **Dependencies:** W1-W2; W0 for pins.

- T01e internal deployment contracts, engine-bound mount resolution and executor-resolved
  readiness targets; desktop projection preserves the existing session port contract.
- Local-Docker and WSL-Docker executors with explicit socket/distro, argv, bounded output and
  cancellation; pull/inspect/create/start/logs/stop/remove; per-scope execution journal with full
  container identity.
- Verified entrypoint script with heartbeat watchdog; `--restart=no`; loopback publication; read-only
  model mounts; bounded IPC; no socket, no privileged mode.

**Exit evidence:** deterministic identity, timeout and crash tests; a real core crash leaves no
container after the stale limit; foreign containers untouched; stop cannot release before exit.

### W4-L — provision Linux from Atomic Chat

**Owner:** core orchestration + app helper. **Dependencies:** W2-W3 and Linux W0.

- Probe Docker, driver, GPU test, group membership. Adopt a passing installation unchanged.
- Bundled `pkexec` helper with one enumerated action installing Docker Engine and NVIDIA Toolkit
  from vendor repositories, configuring the runtime, starting the service, adding the user to
  `docker`. Persist `relogin-required` and resume at next launch.

**Exit evidence:** clean Ubuntu, Ubuntu with Docker but no Toolkit, and Ubuntu with a working GPU
Docker all reach ready from the app without a terminal; denied authorization, low disk, interrupted
install and sign-out continuation recover; existing containers survive.

### W4-W — provision WSL on Windows from Atomic Chat

**Owner:** core orchestration + app helper. **Dependencies:** W2-W3 and Windows W0.

- Probe virtualization, WSL, driver. Elevated helper enables WSL features; persist `reboot-required`
  and resume. Import the owned distribution as the original user, configure systemd, install the
  pinned guest Docker and Toolkit, verify GPU and loopback.
- Guest commands and file operations through `wsl.exe -d <distro> --exec` with fixed argv;
  heartbeat path chosen from measurement.

**Exit evidence:** clean Windows reaches ready through the app with only the UAC prompt and restart;
original-user ownership survives alternate admin credentials; existing distributions untouched;
resume after reboot has no duplicate import.

### W5 — apply the residency rule to every local runtime

**Owner:** core. **Dependencies:** W1.

- Pure residency policy plus integration in the core session owner: any local GPU load stops every
  other local GPU session of every provider, waits for confirmed exit, then reserves. Native
  llama.cpp/MLX auto-unload, context recreate, diffusion idle unload and shutdown use the same path.
- Reservation held until confirmed process or container exit. External processes are never killed;
  allocation failure reports out-of-memory.

**Exit evidence:** GPU01-GPU04 traces; loading TensorRT while sd.cpp generates stops sd.cpp and
loads; loading llama.cpp CUDA while TensorRT is resident stops the container; CPU llama.cpp is not
evicted; failed native exit keeps the reservation.

### W6 — add the chat provider and model acquisition

**Owner:** core + app extension + conf. **Dependencies:** W1-W3, W5 and W0.

- Shared managed-text lifecycle using injected deployment bindings and internal targets; engine
  adapters do not choose host publication, Docker transport or owner shutdown behavior.
- Compiled adapter registry; the `tensorrt-llm` adapter: model
  and settings validation against the descriptor and GPU facts, argv pinned to the tested release,
  readiness probe, capabilities, resource estimate.
- Model resolution: Hugging Face repository -> `config.json` architectures, ModelOpt quantization,
  file inventory and sizes -> compatibility with reasons; resumable verified snapshot download into
  native or guest storage; gated credentials in the core.
- Provider registration in resolver/client contracts, the app extension, model factory, settings,
  Agent routing. Existing GGUF models keep their engines.

**Exit evidence:** a curated model and a pasted repository download, load, stream, cancel and unload
through app chat, Agent and public API; incompatible architecture, unsupported quantization and
oversized weights are refused before download with the reason.

### W7 — reuse setup presentation for chat and provider settings

**Owner:** app. **Dependencies:** W1-W2; W4/W6 for end-to-end.

- Extract requirement/progress/error/retry presentation from the image setup components. Entry
  points in chat model selection and local-provider settings. Model picker with curated tiers and a
  repository input showing the compatibility verdict.
- Store fed by core snapshot/events; distinct steps for system preparation, authorization, sign-out
  or restart, image download, verification. Close hides; cancel cancels; reopen restores.

**Exit evidence:** UI tests cover both entry points, shared operation, close/reopen, core restart,
`relogin-required`, `reboot-required`, cancel/error/retry, unsupported host, incompatible model.

### W8 — finish update, removal, storage moves and shutdown

**Owner:** core + app system commands. **Dependencies:** W2-W7.

- Staged pull/verify, resident unload, smoke, activate, rollback digest per installation. Scoped
  removal; environment removal refused while referenced; no global prune.
- Data move/reset: quiesce sessions, move scope data, keep the shared environment. Full exit stops
  owned containers; tray keeps them; CLI independent; restart reconciles journals.

**Exit evidence:** failed update and rollback, interrupted move/reset, low disk, removal during
setup, crash/exit/tray and concurrent CLI cases; no lost model data or foreign mutation.

### W9 — verify NVFP4 and the compute-capability filter on the 5090

**Owner:** core. **Dependencies:** W6.

- Run NVFP4 checkpoints through the same lifecycle; record correctness, memory, cancellation and the
  rc27 known issue. Confirm the filter hides NVFP4 on the 4070 and shows it on the 5090.

**Exit evidence:** per-checkpoint result on the 5090; filter evidence on both cards.

### W10 — qualify, package and publish the first release

**Owner:** all three repositories. **Dependencies:** W0-W8; W9 for NVFP4 entries.

- Core `npm run verify`, app `make verify`, paired contract suites, Windows and Linux live tests.
- Fresh install, upgrade from a pre-feature app, offline/interrupted setup, denied privilege,
  sign-out and reboot continuation, cancellation, crash, model switch, rollback on both OSes.
  Smoke llama.cpp, MLX and image generation.
- Package helpers, entrypoint script, extension and core for both OSes; publish descriptor JSON to
  conf; bump the app core pin. Rollback means disabling setup advertisement and restoring compatible
  binaries and metadata.

**Exit evidence:** reproducible release checklist with artifact IDs and logs; automatic setup and
chat on both OSes; update/uninstall recovery.

## 4. Reviewable change sequence

1. Hardware reports and contract/schema fixtures; no enabled provider.
2. Durable environment state machine and fake executors.
3. Container executor, journal, watchdog and recovery.
4. Linux installer and Windows installer as separate platform changes.
5. Residency rule across native runtimes and diffusion.
6. Model resolution, download, TensorRT runtime, app extension and UI.
7. Update/removal/data lifecycle and release qualification.
8. NVFP4 evidence as an independently releasable catalog addition.

## 5. Plan verification and current limitations

This plan derives from the inspected code and upstream sources linked in the architecture. The
implementation it has produced so far is listed in §0; it claims no measured performance yet. On the operator's machine the
required Yarn 4.5.3 runs through Volta (`volta run --yarn 4.5.3 yarn …`); T00a records the
baseline with it.
