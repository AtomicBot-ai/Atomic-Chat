---
date: 2026-09-22
title: "Specify managed TensorRT-LLM behavior and repository ownership"
status: proposed
---

# Managed TensorRT-LLM: functional specification and integration map

- **Context:** The [architecture](2026-09-22-propose-managed-tensorrt-llm-architecture.md) uses one
  container image on Linux and Windows/WSL, a shared per-user environment and a one-resident-model
  GPU rule. We need observable behavior and repository boundaries before ordering the work.
- **Proposed decision:** Define durable setup operations, typed model locations, computed model
  compatibility, the residency rule and concrete app/core seams below. Route names and fields are
  proposed contracts, not endpoints available in core 0.3.0.
- **Consequences:** Coordinated core/app releases and paired fixtures are required. Hardware and
  installer qualification remain gates. This document adds no code.
- **Owner:** team.

Revised 2026-09-22 per the architecture's §0: no session gateway, no request accounting, system
Docker on Linux, heartbeat watchdog, unsigned catalog, universal model policy.

## 1. User-facing scope

vLLM and SGLang are future adapters; setup state, artifacts, lifecycle and UI are parameterized by
engine/installation, but only TensorRT-LLM is offered.

A user can discover TensorRT-LLM, prepare the environment from Atomic Chat with one click and the
OS's own authorization prompt, pick a model from the curated list or paste a Hugging Face
repository, download it, load it, converse/stream/cancel, use the same public API, unload and
inspect logs. Text inference only. The app names the engine and explains only what affects user
choices; paths, Docker contexts and WSL commands live in diagnostics.

Availability: `supported`, `setup-required`, `prerequisite-blocked`, `unsupported`. Windows 11 x64
with WSL2 and Ubuntu 24.04 x86_64 are the automated-install baselines; other distributions show
`prerequisite-blocked` with instructions until their recipe exists. Single GPU initially.

## 2. Setup, interruption and removal

### Reuse the existing setup UI

`web-app/src/containers/dialogs/ImageSetupDialog.tsx` (introduction -> engine -> model),
`ImageEngineBlock`, `web-app/src/containers/images/ImageSetupCard.tsx` and `MediaSettingsPanel.tsx`
exist for images; chat has `SetupBackendStep.tsx` and `useBackendUpdater.ts`. Extract a shared
engine setup presentation only where needed; keep the image introduction and model picker for
images; add a text model picker. Reuse row/button/dialog styling and progress/error rendering, not
sd.cpp archive logic.

Entry points for the same setup operation: a TensorRT-compatible model in the chat model flow
offers `Set up TensorRT-LLM`; the local-provider settings page exposes setup/status/update/removal.

Visible sequence: requirements and download summary -> environment preparation -> model selection
-> return to the original context. Preparation shows named substeps: system components,
authorization, sign-out or restart when required, environment, image download, verification.
Closing the dialog hides it without cancelling; cancellation is explicit. A second entry point joins
the running operation. If the environment is ready, skip to model selection. Installation never
switches the active provider, downloads an unselected model or accepts a model license.

The current `useImageEngine()` install path resolves and extracts sd.cpp archives; it cannot own
OCI images or WSL state. Text setup gets an environment client/store fed by core snapshot and SSE.
Readiness is per engine and model: environment ready, model downloaded and model loaded are three
states; the image wizard's `any complete artifact` shortcut is not copied.

### Durable operation

Core preflight returns detected host/driver/GPU (compute capability, VRAM), the environment state,
the proposed package, required host actions, download and disk estimates, whether elevation,
sign-out or reboot is needed, and blockers. Checking availability does not install anything or
pull the 16 GB image.

`Install` starts an idempotent operation with an operation ID and client request ID. Phases:
`checking`, `awaiting-consent`, `preparing-host`, `relogin-required`, `reboot-required`,
`preparing-environment`, `pulling-image`, `verifying`, `activating`, `ready`, `cancelling`,
`cancelled`, `failed`. Progress uses bytes when measured. Completed stages and failure detail are
persisted. `ready` means the environment or installation is verified; model readiness is separate.

The core requests one enumerated privileged action tied to the operation, recipe digest and
validated parameters. The app shows the concrete system changes, invokes the OS helper (`pkexec` on
Linux, UAC on Windows) and reports a receipt; the core re-probes. The webview never receives shell
access, root, Docker sockets or the control token. A decline leaves a resumable state. CLI callers
see `elevation-required` if they cannot run the platform flow.

Linux: adopt an existing Docker that passes the GPU test without changes. Otherwise the helper
installs Docker Engine and the NVIDIA Container Toolkit, configures the runtime, starts the service
and adds the user to the `docker` group; the operation then waits in `relogin-required` until the
group is effective, re-probing at each app launch. Windows: the helper enables WSL features; the
core persists `reboot-required`, resumes on next launch, imports the distribution as the original
user, configures systemd and installs the guest Docker recipe.

Cancellation is cooperative at package-manager boundaries. After a crash, the core queries real
machine state before retrying any mutation.

### Update and removal

Updating an installation pulls and verifies the candidate, unloads the resident model, runs a smoke
load with an explicitly selected model, activates and keeps the previous digest. Remove-model and
remove-runtime are distinct actions with a data-impact preview. Removal stops only owned containers
and removes only owned data; the system Docker, foreign containers, other distributions and the
driver are untouched. Environment removal is refused while installations remain. Factory reset and
data-folder move quiesce owned sessions and move scope data; the shared environment stays where it
is.

## 3. Models, compatibility and Agent

A model record holds a stable model ID, provider, repository, revision, file inventory, format,
architecture class, quantization, size, license/source metadata and the computed compatibility per
installation. Compatibility is computed from the descriptor, `config.json` and the host GPU:

1. `architectures` must intersect the descriptor's `supported_architectures`.
2. The quantization format must have a minimum compute capability at or below the host's.
3. Weight bytes plus the KV reserve must fit the measured free VRAM.

Each failure carries a user-readable reason and the numbers. GGUF is never offered to this engine.
The curated list is filtered by the same checks and grouped by VRAM tier. A pasted repository is
resolved through the Hugging Face API (files, sizes, `config.json`) before any weight download;
gated repositories use core-held credentials.

The downloader materializes the complete inventory with resumable staging and commits only after
verification. Storage is a tagged locator (native or WSL guest) plus a relative path; host paths
are canonicalized before mounting or deleting. GGUF registry files continue to round-trip
unchanged. No conversion, no model Python code, no `pip install`.

Settings initially expose context length, output limit and the KV-cache memory fraction. Runtime
and model capabilities gate tools, vision, structured output, Responses and embeddings; nothing is
claimed by analogy with llama.cpp.

Load: apply the residency rule (unload every other local GPU session and wait for exit), create the
container, verify identity and readiness, publish the loopback session endpoint. Stop-during-load
is honored while queued; a cancelled load cannot publish a ready session. Unload stops the
container and waits for confirmed exit.

Agent, voice, RAG and the public API reach the session at its loopback `host:port` exactly as they
reach llama.cpp today. Agent resolves `tensorrt-llm` as a local OpenAI-compatible provider and must
not fall into the cloud branch. `bypassAutoUnload` does not exempt a caller from the residency rule.

## 4. Scope boundary: text inference

No TensorRT image generation, VisualGen adapter, image models or Images UI. Existing image
functionality is touched only by the residency rule.

## 5. GPU residency contract

Session states: `loading`, `ready`, `stopping`, `failed`. One rule, in the core session owner:

- Before a local GPU load, every other local GPU session in the scope is stopped, regardless of
  activity, and the load waits for each confirmed exit. Generation in progress is interrupted and
  callers get the usual connection error.
- The reservation for the loading or resident model is held until confirmed exit (native process
  reaped, or container observed exited or absent by its own engine). A failed stop keeps it.
- CPU-only native sessions do not take the GPU. Foreign processes and the CLI scope are never
  terminated; an allocation failure is reported as out-of-memory with measured numbers.
- Native llama.cpp/MLX auto-unload, context-growth recreate, diffusion idle unload and shutdown all
  go through the same owner path.

Session identity is `{scope, provider, modelId, generation}`. Container sessions have a null host
PID and an execution kind; TypeScript and Rust consumers are updated together. Native session
values remain meaningful.

## 6. Control operations and events

Exact bodies, statuses and traces are in the [coding contracts](2026-09-22-specify-managed-runtime-coding-contracts.md).

Environment routes under `/atomic/v1`: `list`, `probe`, `begin`, `get`, `cancel`, `resume`,
`host-step-result`, plus model `resolve` (Hugging Face repository -> inventory and compatibility).
Targets are the environment or one installation. Snapshot includes environments and current
operations; events carry operation/instance identity and revision. Reconnect rebuilds from snapshot
then SSE. Mutation retry needs the same request ID or a prior status lookup.

Error codes: unsupported host, driver prerequisite, elevation declined, relogin required, reboot
required, insufficient disk, registry/network failure, image verification failure, GPU busy,
out of memory, cancelled, container exit, cleanup failure, model incompatible. Reuse existing codes
where the meaning matches.

The descriptor binds engine/adapter identity, image digest and platform, host recipes with their
digests, minimum core/app versions, supported architectures, quantization matrix, curated models,
size estimates, notices and exclusions. It is fetched over HTTPS from the release repository and
cached; a digest verifies bytes, not GPU compatibility. Signing is deferred.

## 7. Repository integration map

Paths exist unless marked **new**. New modules stay inside existing `src/`, `extensions/` or script
trees; new dependencies need the repository's normal approval.

### atomic-chat-core

- `src/contracts/{session,events,errors,control-api,model-yml}.ts`: provider/capabilities,
  execution kind, setup state and event shapes. **New:** `src/contracts/environment.ts`.
- `src/client/control-client.ts`, `src/server/control/{types.ts,routes/}`: environment and model
  resolution operations. `src/core/{create,atomic-core,sessions}.ts`: wiring, residency rule,
  shutdown, session resolution.
- **New under `src/runtime/`:** `environment/` (reducer, store, recovery, service, probes, plans,
  provisioners), `container/` (argv, process, docker, journal, watchdog, wsl), `managed-text/`
  (adapter contract, registry, lifecycle), `tensorrt-llm/` (adapter, args, runtime).
- `src/runtime/shared/`, `src/lock/process-journal.ts`: execution-identity union, verified stop,
  recovery; native and container records coexist.
- `src/runtime/llamacpp/runtime.ts`, `src/runtime/mlx/runtime.ts`, `src/diffusion/`: route unload
  decisions through the residency rule; no backend flag changes.
- `src/models/{registry,hf,model-yml,capabilities}.ts`, `src/downloads/`, `src/config/paths.ts`:
  inventories, staged download, compatibility, tagged locations, shared root and scope paths.
- `src/backend/catalog/`, `src/settings/`, `src/hardware/`: descriptor fetch/cache, runtime
  settings, compute capability and VRAM evidence.
- `test/{contract,e2e,live}/`, `docs/testing-critical-flows.md`: paired fixtures, fake Docker/WSL
  tests, real OS/GPU evidence.

### Atomic Chat

- `extensions/shared/atomicCoreRuntime.ts` and **new** `extensions/atomic-tensorrt-llm-extension/`:
  provider adapter, catalog/settings integration, control calls. Review `extensions/package.json`
  and pre-install packaging; keep existing `janhq-*` archive names.
- `core/src/browser/extensions/engines/`, `web-app/src/constants/providers.ts`,
  `web-app/src/services/providers/`, `web-app/src/routes/settings/providers/`: registration,
  availability and setup UI; first-load setup reachable from model selection.
- `web-app/src/lib/model-factory.ts`, `web-app/src/services/models/`,
  `src-tauri/src/core/agent/target.rs`, `src-tauri/src/core/sessions/{mirror,resolver}.rs`:
  container-capable sessions with null PID and local Agent routing.
- `src-tauri/src/core/atomic_core/{commands,relay,supervisor}.rs`: control relay, snapshot/SSE
  recovery, platform setup handoff. **New:** `src-tauri/src/core/runtime_setup/` with the Linux
  `pkexec` helper target and the Windows elevated helper.
- `web-app/src/containers/dialogs/ImageSetupDialog.tsx` and setup components: presentation reuse
  only; no TensorRT in Images.
- `src-tauri/src/core/app/commands.rs`, `src-tauri/src/core/system/commands.rs`: quiesce/move/reset
  integration. The existing `via_wsl` detection is for coding agents, not this installer.
- `scripts/download-core.mjs`, root `package.json` core pin, `src-tauri/capabilities/`, bundle
  scripts: matched core release, helper artifacts, entrypoint script, permissions.
- `tests/core-contracts.test.mjs`, web/extension/Rust suites, app e2e: existing llama.cpp/MLX/sd.cpp
  flows and public OpenAI compatibility survive the contract revision.

### Release metadata

atomic-chat-conf supplies the descriptor JSON over HTTPS, the same trust as
[backends/manifest.json](https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json)
today. Its [schema](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/34ecae48ccda1ea58cc6e1a479c19e004f1a6e88/backends/schema.json)
is llama.cpp-specific; add a separate `runtimes/` manifest and schema and extend
[validate.yml](https://github.com/AtomicBot-ai/atomic-chat-conf/blob/34ecae48ccda1ea58cc6e1a479c19e004f1a6e88/.github/workflows/validate.yml)
with digest/platform uniqueness and schema-version checks. The first hardware experiment uses a
pinned local descriptor. Local providers do not belong in `providers/registry.json`.

## 8. Acceptance evidence before release

Interrupted setup and resume without duplicate resources; safe mutation retry; declined elevation;
`relogin-required` and `reboot-required` continuation; failed image verification; app restart and
reconnect; original-user WSL registration; unknown container never adopted or killed; core crash
frees the GPU through the watchdog; load during generation interrupts and reloads cleanly; pasted
incompatible repository refused before download with the reason; too-large model refused with the
numbers; public listener disabled with working local chat and Agent; existing setup regression;
update rollback; full exit vs tray vs CLI; data move guard; foreign Docker resources untouched.

Deterministic cases use fake Docker/WSL executables and local fixture HTTP servers. Hardware cases:
engine version, compute capability, real inference, VRAM before/after, cancellation, exit, FP8 on
Ada, NVFP4 on Blackwell. Installer cases need the real OSes and desktop prompts.
