---
date: 2026-09-22
title: "Specify managed-runtime coding contracts and transition tests"
status: proposed
---

# Managed text runtime: implementation contracts

- **Context:** Small coding assignments need exact shared types, methods and observable transitions.
- **Decision:** The signatures and transition rules below are the implementation target for the
  [agent backlog](2026-09-22-sequence-tensorrt-llm-agent-tasks.md). Change this contract through its
  owning child task before changing dependent implementations.
- **Consequences:** Wire contracts and private execution authority stay separate. Consent,
  cancellation, shared-environment ownership and the residency rule have explicit outcomes and tests.
- **Owner:** team. Proposed interfaces only.

Revised 2026-09-22 per the architecture's §0: request leases, drain tickets, the session gateway,
the guardian command channel and signature types are removed; `relogin-required`, the Linux
container-runtime host action, model resolution and the residency contract are added.

## Ownership and conventions

T01a owns wire types, T01b descriptor parsing and canonical JSON, T01c paths, T01d paired fixtures.
T04a owns the operation reducer; T06a the executor contract; T11a the residency contract; T14a the
compiled adapter registry; T13d model resolution.

The TypeScript blocks form one type-checkable declaration set; split them into the stated modules.
Internal interfaces are not exported through control API JSON. `AtomicCoreError` is the thrown
error envelope; add the codes below to the common union and mirrored fixtures. IDs are strings on
the wire and validated once at boundaries; filesystem IDs use canonical safe encoding. Byte counts
are finite nonnegative safe integers. Timestamps are UTC strings.

```ts
// Wire types, implemented verbatim in CORE `src/contracts/environment.ts` (T01a).
// IDs are plain strings on the wire and validated once at the boundary; an alias of `string`
// would add no safety. The failure envelope is this repository's existing `ErrorBody`.
export type Sha256Digest = `sha256:${string}`

export const EXECUTOR_KINDS = ['linux-docker', 'wsl-docker'] as const
export type ExecutorKind = (typeof EXECUTOR_KINDS)[number]

export const MANAGED_OPERATION_KINDS = ['setup', 'update', 'remove'] as const
export type ManagedOperationKind = (typeof MANAGED_OPERATION_KINDS)[number]

export type ManagedOperationTarget =
  | { kind: 'environment' }
  | { kind: 'runtime'; installation_id: string; engine_id: string }

export const MANAGED_PHASES = [
  'checking', 'awaiting-consent', 'preparing-host', 'relogin-required', 'reboot-required',
  'preparing-environment', 'pulling-image', 'verifying', 'activating', 'removing',
  'ready', 'removed', 'cancelling', 'cancelled', 'failed',
] as const
export type ManagedPhase = (typeof MANAGED_PHASES)[number]

export const MANAGED_AVAILABILITY = [
  'supported', 'setup-required', 'prerequisite-blocked', 'unsupported',
] as const
export type ManagedAvailability = (typeof MANAGED_AVAILABILITY)[number]

export const RUNTIME_INSTALLATION_STATUSES = [
  'absent', 'installing', 'ready', 'updating', 'removing', 'failed',
] as const
export type RuntimeInstallationStatus = (typeof RUNTIME_INSTALLATION_STATUSES)[number]

export interface ManagedProgress {
  label: string
  completed: number | null
  total: number | null
  unit: 'bytes' | 'steps' | 'unknown'
}

/** Bytes, not the MiB of `backend/types.ts`'s `GpuProbeInfo`; `compute_capability` is "major.minor". */
export interface GpuFacts {
  gpu_id: string
  name: string
  compute_capability: string
  total_vram_bytes: number | null
  free_vram_bytes: number | null
  driver_version: string | null
}

export interface RuntimeInstallation {
  installation_id: string
  engine_id: string
  environment_id: string
  active_descriptor_id: string | null
  candidate_descriptor_id: string | null
  availability: ManagedAvailability
  status: RuntimeInstallationStatus
}

export interface EnvironmentSnapshot {
  schema_version: 1
  environment_id: string
  instance_id: string
  revision: number
  executor: ExecutorKind
  availability: ManagedAvailability
  gpus: GpuFacts[]
  installations: RuntimeInstallation[]
  active_operation_id: string | null
}

export const MANAGED_HOST_ACTIONS = ['linux.install-container-runtime', 'windows.enable-wsl'] as const
export type ManagedHostAction = (typeof MANAGED_HOST_ACTIONS)[number]

export interface ManagedHostStep {
  step_id: string
  action: ManagedHostAction
  recipe_id: string
  recipe_digest: Sha256Digest
  parameters_digest: Sha256Digest
  nonce: string
  expected_operation_revision: number
}

export interface ManagedHostReceipt {
  step_id: string
  nonce: string
  expected_operation_revision: number
  recipe_digest: Sha256Digest
  parameters_digest: Sha256Digest
  outcome: 'completed' | 'declined' | 'relogin-required' | 'reboot-required' | 'failed'
  receipt_id: string
}

export interface EnvironmentOperation {
  schema_version: 1
  operation_id: string
  request_id: string
  environment_id: string
  target: ManagedOperationTarget
  kind: ManagedOperationKind
  instance_id: string
  revision: number
  phase: ManagedPhase
  plan_digest: Sha256Digest | null
  approved_plan_digest: Sha256Digest | null
  progress: ManagedProgress | null
  pending_host_step: ManagedHostStep | null
  completed_step_ids: string[]
  cancellation_requested: boolean
  error: ErrorBody | null
}

export interface BeginOperation {
  request_id: string
  target: ManagedOperationTarget
  kind: ManagedOperationKind
  descriptor_id?: string
  retain_models?: boolean
  approved_plan_digest?: Sha256Digest
}

export interface ResumeOperation {
  expected_revision: number
  approved_plan_digest?: Sha256Digest
}

export interface RequirementPlan {
  plan_digest: Sha256Digest
  environment_id: string
  target: ManagedOperationTarget
  availability: ManagedAvailability
  recipe_id: string
  recipe_digest: Sha256Digest
  adopts_existing_engine: boolean
  system_changes: string[]
  download_bytes: number | null
  required_disk_bytes: number | null
  requires_elevation: boolean
  may_require_relogin: boolean
  may_require_reboot: boolean
  blockers: ErrorBody[]
}

export interface ProbeEnvironmentInput {
  descriptor_id: string
  environment_id?: string
  target: ManagedOperationTarget
}

export interface QuantizationSupport { format: string; min_compute_capability: string }

export interface RuntimeDescriptor {
  schema_version: 1
  descriptor_id: string
  engine_id: string
  adapter_id: string
  adapter_contract_version: 1
  image: { repository: string; digest: Sha256Digest; platform: 'linux/amd64' }
  entrypoint_digest: Sha256Digest
  minimum_core_version: string
  minimum_app_version: string
  minimum_compute_capability: string
  supported_architectures: string[]
  quantization: QuantizationSupport[]
  recipes: { executor: ExecutorKind; recipe_id: string; digest: Sha256Digest }[]
  curated_models: {
    repository: string
    revision: string
    inventory_digest: Sha256Digest
    vram_tier_bytes: number
    note: string
  }[]
  download_bytes: number | null
  required_disk_bytes: number | null
  notices: string[]
  exclusions: string[]
}

export interface ResolvedModelFile { path: string; bytes: number }

export interface ModelResolution {
  repository: string
  revision: string
  architectures: string[]
  quantization: string | null
  weight_bytes: number
  files: ResolvedModelFile[]
  compatibility: { ok: true } | { ok: false; error: ErrorBody }
  gated: boolean
}

// Internal, never serialized through the control API. Each is owned by its own card and is not
// part of T01a: `Result` and the reducer types by T04a, the store by T04b, the service by T05a.
export type Result<T> = { ok: true; value: T } | { ok: false; error: ErrorBody }

export interface EnvironmentService {
  list(): Promise<EnvironmentSnapshot[]>
  probe(input: ProbeEnvironmentInput): Promise<RequirementPlan>
  begin(environmentId: string, input: BeginOperation): Promise<EnvironmentOperation>
  get(operationId: string): Promise<EnvironmentOperation>
  cancel(operationId: string): Promise<EnvironmentOperation>
  resume(operationId: string, input: ResumeOperation): Promise<EnvironmentOperation>
  acceptHostReceipt(operationId: string, receipt: ManagedHostReceipt): Promise<EnvironmentOperation>
  recover(instanceId: string): Promise<void>
  shutdown(signal: AbortSignal): Promise<void>
}

export interface PersistedOperation {
  machine: OperationMachine
  request_digest: Sha256Digest
  request: BeginOperation
  requirement_plan: RequirementPlan | null
  accepted_receipt_digests: Record<string, Sha256Digest>
  completed_effect_ids: string[]
  owned_resource_ids: string[]
}

export interface OperationStore {
  createOrGet(environmentId: string, input: BeginOperation,
    requestDigest: Sha256Digest): Promise<{ record: PersistedOperation; created: boolean }>
  read(operationId: string): Promise<PersistedOperation | null>
  compareAndSwap(operationId: string, expectedRevision: number,
    next: PersistedOperation): Promise<boolean>
  listRecoverable(): Promise<PersistedOperation[]>
}
```

The store lives in the shared per-user root and is used by both the app and CLI cores; it takes an
exclusive file lock around every CAS so two cores cannot interleave writes.

### HTTP, validation and retry behavior

Use the `/atomic/v1` token-authenticated route family. GET list returns
`{environments: EnvironmentSnapshot[]}`; GET operation and each mutation return the operation
object. POST probe takes `ProbeEnvironmentInput` and returns `RequirementPlan`. POST begin returns
202; the rest 200. New routes reject unknown fields, malformed IDs and invalid enums with 400
`INVALID_ARGUMENT`.

No matching operation: 404. Conflicting request, revision, plan or receipt, or referenced deletion:
409 with the relevant code. Missing approval: 409 `MANAGED_CONSENT_REQUIRED`, operation stays
`awaiting-consent`. Invalid metadata or host-step payload: 400; missing adapter: 422. Prerequisite
unavailability is a successful probe with blockers. Long-running failures go into operation state.
Never expose secret command output in `details`.

Fingerprint the immutable begin request (target and descriptor included). Same request ID with an
equal fingerprint returns the existing object; unequal returns 409. Setup/update require a
descriptor ID; remove uses the recorded identity. Canonical UTF-8 JSON (sorted keys recursively,
array order preserved) is hashed; T01b owns that helper. Plan hashes include descriptor/recipe
digests, target, parameters and the actual system changes.

An identical already-accepted receipt returns the current operation without replay. A different
receipt for a consumed nonce returns `MANAGED_RECEIPT_CONFLICT`; wrong pending identity returns
`MANAGED_HOST_STEP_INVALID`. Receipt success always triggers a host re-probe.

Events are `environment:changed` and `environment:operation`. Snapshot fields are `environments`
and `environment_operations`. Apply events only for the current instance and a strictly newer
revision. Store writes never lose a previous valid record; corrupted records block mutation.

## Operation transition rules (T04a)

The reducer takes previous immutable state plus a typed event and returns next state and effect
intents. No I/O, no random IDs, no clock. Internal success events are accepted only for the
pending effect identity/revision and expected phase. Each accepted change increments revision.

```ts
export type EffectKind = 'probe' | 'host-step' | 'prepare-environment' | 'pull-image'
  | 'verify' | 'unload-resident' | 'activate' | 'remove' | 'cleanup' | 'reconcile';
export interface EffectIntent {
  effect_id: string;
  operation_id: string;
  expected_revision: number;
  kind: EffectKind;
  plan_digest: Sha256Digest | null;
}
export interface OperationMachine {
  operation: EnvironmentOperation;
  pending_effect: EffectIntent | null;
  indivisible_host_step_running: boolean;
}
export interface EventIdentity { effect_id: string; expected_revision: number; }
export type OperationEvent =
  | ({ type: 'requirements-ready'; plan: RequirementPlan; host_step: ManagedHostStep | null } & EventIdentity)
  | { type: 'approve'; input: ResumeOperation }
  | ({ type: 'host-step-started' } & EventIdentity)
  | ({ type: 'host-receipt-verified'; receipt: ManagedHostReceipt; prerequisites_met: boolean } & EventIdentity)
  | ({ type: 'environment-verified' } & EventIdentity)
  | ({ type: 'image-pulled' } & EventIdentity)
  | ({ type: 'verification-passed' } & EventIdentity)
  | ({ type: 'resident-unloaded' } & EventIdentity)
  | ({ type: 'activation-committed' } & EventIdentity)
  | ({ type: 'removal-completed' } & EventIdentity)
  | { type: 'cancel' }
  | ({ type: 'safe-boundary' } & EventIdentity)
  | ({ type: 'cleanup-completed' } & EventIdentity)
  | { type: 'resume'; input: ResumeOperation }
  | ({ type: 'failed'; error: ErrorBody } & EventIdentity)
  | ({ type: 'reconciled'; instance_id: string; verified_completed_step_ids: string[];
       current_plan_digest: Sha256Digest | null; needs_relogin: boolean; needs_reboot: boolean } & EventIdentity);
export interface TransitionInput { next_effect_id: string; }
export declare function reduceOperation(state: OperationMachine, event: OperationEvent,
  input: TransitionInput): Result<{ state: OperationMachine; effects: EffectIntent[] }>;
```

Effect arguments come from the persisted descriptor and plan, never from caller JSON. T04b persists
pending effect and next state in one CAS before the runner starts. Recovery never accepts a
wire-supplied `reconciled` event. Resume/approve first schedule re-probe; they cannot skip to
privileged work. `host-receipt-verified` is a private result of receipt validation plus probing.

**Setup sequence:**

1. `begin` persists `checking` before probing.
2. `requirements-ready`: blockers -> `failed` with an actionable error; approval missing or
   mismatched -> `awaiting-consent`; exact approval -> `preparing-host` if a host step is needed,
   else `preparing-environment`. A plan with `adopts_existing_engine` has no host step.
3. `approve` is `/resume` with matching revision and plan hash. Re-probe first; if the plan changed,
   stay `awaiting-consent` with the new hash and return `MANAGED_PLAN_CHANGED`.
4. `preparing-host`: issue only the pending enumerated host step. Declined -> `failed`.
   Receipt `relogin-required` -> `relogin-required`; `reboot-required` -> `reboot-required`;
   `completed` -> re-probe, then `preparing-environment`.
5. `relogin-required` and `reboot-required`: resume re-probes. Prerequisite still unmet -> retain
   the phase; met -> invalidate the consumed nonce and continue. Never re-elevate blindly.
6. `preparing-environment`: on Linux verify the adopted or installed engine and GPU test; on
   Windows import/verify the distribution and install the guest engine. Environment-only target ->
   `verifying`; runtime target -> `pulling-image`. Existing compatible resources are adopted only
   after identity verification.
7. `pulling-image` -> `verifying` -> `activating` after runtime checks pass. Environment-only
   verification -> `ready`.
8. `activating`: commit this installation's active descriptor atomically, then `ready`. Keep the
   previous descriptor for rollback. No sibling installation changes.

**Update sequence:** same consent rules; stage `pulling-image` -> `verifying` while the old digest
stays active; `unload-resident` stops the resident model through the residency rule; smoke load
with the explicitly selected model; success -> `activating` -> `ready`; failure -> `failed` with the
old descriptor still usable.

**Remove sequence:** consent -> `removing` -> `removed`. Environment removal with installed
references fails before stopping anything. Runtime removal stops only its owned execution, unlinks
references, removes private cache and deletes selected unreferenced artifacts. Stop-unconfirmed ->
`failed` with journal and reservation kept.

**Cancellation and recovery:** `cancel` in `ready`, `removed`, `cancelled` is a no-op. A cancellable
phase -> `cancelling`; abort pull/probe, reconcile, clean only plan-authorized tentative state, then
`cancelled`. During an indivisible package or feature step, persist `cancellation_requested` and
enter `cancelling` at the safe boundary. `resume` in `failed`, `cancelled`, `relogin-required` or
`reboot-required` reconciles then continues. On core restart emit no completion from stored phase;
reconcile intents against identity-verified inventory, assign a new instance ID, increment revision.
Unspecified combinations return `MANAGED_OPERATION_CONFLICT` without effects.

### Required reducer/store fixtures

- **OP01:** begin twice with the same request -> one operation, one effect; changed descriptor with
  the same request -> conflict.
- **OP02:** awaiting approval for plan A, host changes to B, approve A -> no host execution,
  awaiting B. Approve B -> exactly one pending host step.
- **OP03:** replay identical accepted receipt -> no new effect; changed receipt/nonce -> rejection.
- **OP04:** cancel during an indivisible host step -> flag persisted; at completion cancellation
  reconciliation runs with zero further pulls or imports.
- **OP05:** crash after a WSL import succeeds but before the record -> re-probe adopts only the
  exact owned identity; unknown resource -> blocked failure, never adoption or deletion by name.
- **OP06:** candidate smoke fails -> previous digest survives; no ready event for the candidate.
- **OP07:** remove A while B references the environment or an artifact -> B and shared bytes
  preserved; environment removal -> conflict before effects.
- **OP08:** CAS with an old revision -> false, no write, no event. Corrupted latest record ->
  recover the previous valid record or fail closed.
- **OP09:** Linux receipt `relogin-required` -> phase retained across two restarts while the group
  is not effective; effective group -> one `preparing-environment` effect. Adopted engine plan ->
  no host step and no helper invocation.

## Container executor and compiled adapter signatures

```ts
export type ArtifactLocation =
  | { kind: 'native'; storage_domain: string; absolute_path: string }
  | { kind: 'guest'; storage_domain: string; environment_id: string; guest_path: string };
export interface EngineBinding {
  scope_id: string;
  environment_id: string;
  executor: ExecutorKind;
  endpoint: string;            // unix socket path, or the distro name for wsl-docker
  engine_identity: string;         // docker `info` ID
}
export interface ExecutionIdentity {
  execution_id: string;
  binding: EngineBinding;
  installation_id: string;
  engine_id: string;
  container_id: string;            // full 64-hex ID
  created_at: string;
  descriptor_id: string;
  image_digest: Sha256Digest;
  owner_instance_id: string;
  session_generation: string;
}
export interface ContainerState {
  identity: ExecutionIdentity;
  running: boolean;
  exit_code: number | null;
}
export interface LaunchSpec {
  image_repository: string;
  image_digest: Sha256Digest;
  argv: string[];              // arguments to the entrypoint script; the script execs them
  env: Record<string, string>;
  mounts: { source: ArtifactLocation; target: string; read_only: boolean }[];
  heartbeat: { source: ArtifactLocation; stale_after_seconds: number };
  container_port: number;
  host_port: number;
  bind_host: '127.0.0.1';
  shared_memory_bytes: number;
  gpu_id: string;
}
export interface CreateContainer {
  execution_id: string;
  installation_id: string;
  engine_id: string;
  descriptor_id: string;
  owner_instance_id: string;
  session_generation: string;
  launch: LaunchSpec;
}
export interface StopEvidence {
  identity: ExecutionIdentity;
  observed: 'exited' | 'absent';
  checked_engine_identity: string;
}
export interface ExecutorProbe {
  reachable: boolean;
  engine_identity: string | null;
  version: string | null;
  gpu_test: 'passed' | 'failed' | 'not-run';
}
export interface ContainerExecutor {
  probe(binding: EngineBinding, signal: AbortSignal): Promise<ExecutorProbe>;
  pull(binding: EngineBinding, image: { repository: string; digest: Sha256Digest },
    onProgress: (progress: ManagedProgress) => void, signal: AbortSignal): Promise<void>;
  inspect(identity: ExecutionIdentity, signal: AbortSignal): Promise<ContainerState | null>;
  create(binding: EngineBinding, input: CreateContainer, signal: AbortSignal): Promise<ExecutionIdentity>;
  start(identity: ExecutionIdentity, signal: AbortSignal): Promise<void>;
  logs(identity: ExecutionIdentity, after: string | null, signal: AbortSignal): AsyncIterable<string>;
  stop(identity: ExecutionIdentity, timeoutMs: number, signal: AbortSignal): Promise<StopEvidence>;
  remove(evidence: StopEvidence, signal: AbortSignal): Promise<void>;
  touchHeartbeat(identity: ExecutionIdentity, signal: AbortSignal): Promise<void>;
}
export interface ModelArtifact {
  artifact_id: string;
  repository: string;
  revision: string;
  inventory_digest: Sha256Digest;
  format: 'safetensors';
  architectures: string[];
  quantization: string | null;   // ModelOpt quant_algo or null
  weight_bytes: number;
  location: ArtifactLocation;
}
export interface QuantizationSupport { format: string; min_compute_capability: string; }
export interface RuntimeDescriptor {
  schema_version: 1;
  descriptor_id: string;
  engine_id: string;
  adapter_id: string;
  adapter_contract_version: 1;
  image: { repository: string; digest: Sha256Digest; platform: 'linux/amd64' };
  entrypoint_digest: Sha256Digest;
  minimum_core_version: string;
  minimum_app_version: string;
  minimum_compute_capability: string;
  supported_architectures: string[];
  quantization: QuantizationSupport[];
  recipes: { executor: ExecutorKind; recipe_id: string; digest: Sha256Digest }[];
  curated_models: { repository: string; revision: string; inventory_digest: Sha256Digest;
    vram_tier_bytes: number; note: string }[];
  download_bytes: number | null;
  required_disk_bytes: number | null;
  notices: string[];
  exclusions: string[];
}
export interface ModelResolution {
  repository: string;
  revision: string;
  architectures: string[];
  quantization: string | null;
  weight_bytes: number;
  files: { path: string; bytes: number }[];
  compatibility: { ok: true } | { ok: false; error: ErrorBody };   // MODEL_INCOMPATIBLE with reason
  gated: boolean;
}
export type SettingValues = Record<string, string | number | boolean | null>;
export interface AdapterContext {
  descriptor: RuntimeDescriptor;
  artifact: ModelArtifact;
  settings: SettingValues;
  gpu: GpuFacts;
  host_port: number;
  container_port: number;
  cache: ArtifactLocation;
}
export interface BackendTarget { host: '127.0.0.1'; port: number; }
export interface ProbeIO {
  request(target: BackendTarget, path: string, method: 'GET' | 'POST',
    body: string | null, signal: AbortSignal): Promise<{ status: number; body: string }>;
}
export interface ApiPolicy {
  routes: { method: 'GET' | 'POST'; path: string; kind: 'inference' | 'metadata' }[];
  capabilities: { chat: boolean; completion: boolean; responses: boolean; embeddings: boolean;
    tools: boolean; structured_output: boolean; vision: boolean };
}
export interface ManagedTextAdapter {
  readonly engineId: string;
  readonly adapterId: string;
  readonly contractVersion: 1;
  validateModel(descriptor: RuntimeDescriptor, model: ModelArtifact, gpu: GpuFacts): Result<void>;
  validateSettings(descriptor: RuntimeDescriptor, settings: SettingValues): Result<SettingValues>;
  buildLaunchSpec(context: AdapterContext): Result<LaunchSpec>;
  probeReady(target: BackendTarget, io: ProbeIO, signal: AbortSignal):
    Promise<'ready' | 'starting' | 'failed'>;
  describeApi(descriptor: RuntimeDescriptor, model: ModelArtifact): ApiPolicy;
  estimateResources(context: AdapterContext): { resident_bytes: number | null; peak_bytes: number | null };
}
```

T06a validates the LaunchSpec: source locations belong to the bound storage scope, no duplicate or
escaping targets, bounded IPC, loopback publication, pinned digest, no Docker socket, no privileged
mode, `--restart=no`, entrypoint mounted read-only at a fixed path and verified against
`entrypoint_digest`. Runtime env contains no Hugging Face credentials. Only the compiled adapter
determines argv; a descriptor contains no commands.

`inspect`: a failed transport is an error, not `null`; `null` means the verified owned engine
reported the exact container absent. `remove` re-verifies its evidence. `touchHeartbeat` updates
the heartbeat file's mtime through the executor's file path (native write on Linux, automount path
or `wsl.exe --exec touch` on Windows as chosen in T09e). Guest file operations for downloads use
`wsl.exe -d <distro> --exec` with fixed argv and path bounds, never a shell.

Entrypoint script contract (T07b): `exec`s nothing but `trtllm-serve` with the passed argv as a
child; every `interval` seconds checks the heartbeat file's mtime; if older than `stale_after`,
sends TERM then KILL to the child and exits nonzero; exits with the child's status when the child
exits. It reads no network and accepts no commands.

## GPU residency signatures

```ts
export interface SessionKey { scope_id: string; provider: string; model_id: string; generation: string; }
export interface Reservation { reservation_id: string; session: SessionKey; gpu_id: string; }
export type StopProof =
  | { kind: 'container'; execution_id: string; observed: 'exited' | 'absent' }
  | { kind: 'native'; host_pid: number; process_identity: string; verified_exited: true }
  | { kind: 'not-started'; reservation_id: string };
export interface ResidencyOptions { newReservationId: () => string }
export declare class ResidencyPolicy {
  constructor(options: ResidencyOptions);
  /** Sessions that must be stopped before `session` may hold `gpu_id`. Empty when free. */
  evictionsFor(session: SessionKey, gpu_id: string): SessionKey[];
  reserve(session: SessionKey, gpu_id: string): Result<Reservation>;
  markStarted(reservation: Reservation, executionId: string): Result<void>;
  confirmStopped(reservation: Reservation, proof: StopProof): Result<void>;
  list(): { gpu_id: string; session: SessionKey; started: boolean }[];
}
```

All calls are synchronous transitions under the session owner's serialized boundary. `reserve`
returns `GPU_BUSY` while any other session holds or is stopping on that GPU; the owner first asks
`evictionsFor`, stops each listed session through its runtime (interrupting generation), waits for
`confirmStopped`, then reserves. CPU-only sessions never reserve. A verified allocation failure
from the engine yields `OUT_OF_MEMORY`. Residency is held until `confirmStopped`; `not-started`
proof is accepted only before `markStarted`; a timeout or a killed Docker CLI is not proof.
Duplicate confirmations for a known reservation are harmless; a confirmation whose slot has since
been loaded again returns `SESSION_GENERATION_STALE`, and one naming another container or session
returns `MANAGED_IDENTITY_MISMATCH`.

The container proof carries the execution id and what the executor observed rather than T06a's
whole `StopEvidence`: the policy checks that a verified observation exists and names this execution,
not the executor's internals, and this keeps `src/core/gpu` independent of `src/runtime/container`.
The managed-text lifecycle is what turns a `StopEvidence` into this proof. Reservation ids are
injected (`newReservationId`) so the table stays a pure function of its inputs.

`Result<T>` lives in `src/util/result.ts`, not inside either module: the reducer and the residency
policy both return it, and `src/core/gpu` must not import `src/runtime/environment` to get it.

### Required residency traces

- **GPU01:** reserve A; reserve B on the same GPU -> busy; `evictionsFor(B)` = [A]; stop A, confirm
  -> B reserves. A generating A is listed the same as an idle A.
- **GPU02:** reserve A, spawn fails with no child -> `not-started` releases. After `markStarted` the
  same proof is rejected; a failed stop keeps the reservation.
- **GPU03:** old generation confirms -> new generation unchanged. Same PID or model basename is not
  identity; different provider with the same model ID is a distinct key.
- **GPU04:** sd.cpp session resident; TensorRT load lists it for eviction and vice versa; a CPU
  llama.cpp session is never listed.

## Host helper transport and delivery boundary

The app relay forwards a fixed HostStep and hash-verified recipe to the bundled helper. Rust
validates operation ID, revision, nonce, recipe and parameter digests, original user identity and
approved plan hash before elevation. The helper owns argument construction; the webview cannot
choose commands, package sources or paths. It returns a HostReceipt; bounded redacted logs are
separate. No secrets in receipts or elevated command lines.

Linux helper (`linux.install-container-runtime`), invoked through `pkexec` from the app bundle:
adds the Docker and NVIDIA apt repositories with their published keys, installs the pinned
package set, runs `nvidia-ctk runtime configure --runtime=docker`, enables and starts
`docker.service` (restarting it only if it was installed by this step), and adds the original
user to `docker`. It removes no packages. Its trust equals the app's.

Windows helper (`windows.enable-wsl`) enables the WSL and Virtual Machine Platform features only.
Distribution registration and files stay under the original normal user; invocation with alternate
admin credentials must not import into the administrator account.

## Ready-to-code versus external gates

Contracts, parsers, pure policies, journals, fake-process transports, HTTP fixture tests and UI
reducers are ready without GPU access. Real package pins, driver checks, WSL import/reboot and
memory-recovery evidence need their named live child tasks on the 4070 hosts and the 5090.
