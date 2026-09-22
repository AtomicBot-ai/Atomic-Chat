---
date: 2026-09-22
title: "Share managed infrastructure across text inference engines"
status: proposed
---

# Managed text engines: TensorRT-LLM first, vLLM and SGLang next

- **Context:** vLLM and SGLang are planned additions. The TensorRT backlog must not make
  environment installation, storage, UI or GPU ownership depend on one engine name.
- **Decision:** Build shared managed-text infrastructure now; ship TensorRT-LLM as its first
  adapter. Reserve the vLLM/SGLang extension points and prove isolation with two fake adapters.
  Do not implement, advertise or qualify the real future engines in this delivery.
- **Consequences:** Environment and runtime installation are separate records. Containers, launch
  policies, capabilities and writable caches remain specific to an engine and pinned release.
- **Owner:** team.
- **Links:** [coding backlog](2026-09-22-sequence-tensorrt-llm-agent-tasks.md),
  [architecture](2026-09-22-propose-managed-tensorrt-llm-architecture.md).

Revised 2026-09-22 with the product decisions in the architecture's §0: one environment per
machine user shared by app and CLI, no session gateway, one-resident-model GPU rule.

## Scope and evidence

Interpret the requested future "slang" as **SGLang**. Text inference remains the only scope.

Both [vLLM](https://docs.vllm.ai/en/latest/deployment/docker/) and
[SGLang](https://docs.sglang.io/docs/get-started/install) document container deployment and
OpenAI-compatible serving. That justifies a shared execution boundary, not a claim that either
engine works on our Windows/WSL recipe or on a given GPU.

## Four separate identities

1. **Environment:** the container engine substrate, one per machine user, shared by the app and
   CLI scopes. On Linux it is the system Docker Engine; on Windows the owned WSL distribution with
   its Docker. Environment IDs carry no engine meaning. Two cores may operate on it; mutations are
   serialized with a file lock in the shared root.
2. **Runtime installation:** `{installation_id, engine_id, environment_id, active_descriptor_id,
   candidate_descriptor_id, status}`, stored in the shared root so both scopes see the same engine
   version. Each engine/release has a pinned OCI descriptor and independent update/rollback state.
3. **Model artifact:** immutable repository/revision/file-inventory identity in one scope's storage
   domain (native Linux or the WSL guest). Compatibility is a separate result of
   `(engine, descriptor, model revision, GPU, settings)`.
4. **Execution/session:** one running container binding installation, artifact, settings, GPU
   reservation and generation, owned by one scope. Journals retain the provider; matching basenames
   never merge two engines' sessions or authorize stopping the wrong container.

A shared Linux image means one engine's image reused on Linux and Windows/WSL. It never means one
image containing several engines; each engine keeps its own pinned image and cache.

## Shared code versus adapter code

Shared: durable operations, descriptor parsing, platform preparation, Docker executor, container
journal and watchdog, artifact download and compatibility checks, residency rule, setup UI and
catalog cache. These modules must not branch on `engine_id === 'tensorrt-llm'`.

Engine-specific: model/settings validation, supported architecture and quantization tables,
launch argv/env, health/readiness probe, declared API routes, resource estimate and capabilities.

Define `ManagedTextAdapter` in CORE `src/runtime/managed-text/` with a compiled registry. It exposes
`engineId`, `validateModel`, `validateSettings`, `buildLaunchSpec`, `probeReady`, `describeApi` and
`estimateResources`. Pure validators/builders are separate from injected probe I/O. The common
lifecycle owns residency reservation, container creation, journal, heartbeat and stop.

Descriptors reference a registered `adapter_id` and contract version; downloaded metadata cannot
contain code, shell recipes or plugins. The production registry has only TensorRT-LLM. `vllm` and
`sglang` may be recognized as unimplemented; recognition creates no install button, runtime or
model entry.

OpenAI-compatible transport does not make routes, tool parsing, model support or flags identical.
Callers use the routes the adapter declares. Never copy one engine's settings into another's argv.

## Installation, removal and concurrency

Operations target either the environment or one installation and are serialized per environment
across both scopes. Installing a second engine reuses the ready environment and pulls its own image.
If host prerequisites conflict, report the requirement; do not upgrade shared Docker or the guest
under another active installation.

Removing a runtime removes only its executions, private caches and installation record. The
environment stays while another installation exists; environment removal is rejected until every
installation is removed. Artifact deletion needs no remaining installation, model or live reference
and an explicit choice; reference changes are atomic.

Engines share the one-resident-model GPU rule: loading a model on any engine unloads every other
local GPU model. Shared infrastructure never implies concurrent residency or automatic switching.

## Data and UI

Shared per-user root, chosen by T01c and recorded in the core's ADR
`2026-09-22-managed-runtimes-split-per-user-environment-from-per-scope-data`:
`<dataDir>/atomic-managed-runtimes/`, where `dataDir` is the one `config/data-folder.ts` already
resolves (Roaming AppData, Application Support, XDG data). It sits outside any data folder on
purpose, so both scopes drive one environment and a data-folder move leaves it alone;
`ATOMIC_CORE_MANAGED_ROOT` overrides it for tests.

- `environment.json`, `environment.lock`: executor kind, host recipe, guest registration, and the
  lock every mutation takes so an app core and a CLI core cannot interleave writes.
- `installations/<installation_id>/installation.json`: descriptors and installation state.
- `operations/<operation_id>.json`: targeted operation records.

Per scope, under `<data>/atomic-core/managed-runtimes/`:

- `executions/`: private container authority journal.
- `artifacts/<artifact_id>/`: immutable model snapshots in that scope's storage domain.
- `caches/<engine_id>/<descriptor_id>/<artifact_id>/`: private compiled/kernel/runtime caches.
- `heartbeats/<execution_id>`: watchdog heartbeat files.

IDs become one directory each through `encodeManagedId`: every UTF-8 byte outside `[A-Za-z0-9._-]`
is percent-encoded, and `.`, `..`, a trailing dot and the Windows device names are escaped too, so a
repository name is never spelled onto disk raw and never nests on its slash. Do not deduplicate
native and guest stores by treating a guest path as a host path; `managedHostPath` refuses a guest
location rather than returning a string that would resolve to something else on Windows.

The generic setup store/dialog takes an engine/installation ID, descriptor and display label, with
generic translation keys and engine-name parameters. Availability, installed state and progress are
per target; an installed TensorRT runtime does not make vLLM ready.

## Backlog mapping

T01 defines the identities and descriptor fields. T04-T07 handle ownership without engine
branching. T13 implements immutable artifacts, references and compatibility checks. T14 implements
the TensorRT adapter through the shared lifecycle. T16-T18 operate on a chosen installation. T20's
schema covers registered adapters. T24 proves the boundary with two fake engines: independent
setup, update, compatibility and removal in one environment, shared artifacts, residency rule.

Future vLLM and SGLang each need their own image/model/hardware experiment, adapter, app
registration, descriptor and live tests. They must not need a second WSL installer, setup state
machine or watchdog.
