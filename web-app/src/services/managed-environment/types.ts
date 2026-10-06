/**
 * The managed-runtime surface of `atomic-chat-core` 0.7.5 (control protocol 2) as the app reads it:
 * the container environment the core owns on Linux — on Windows, Atomic Chat's own WSL
 * distribution — the TensorRT-LLM installation inside it, the durable operations that set it up and
 * remove it, and the core's verdict on a checkpoint.
 *
 * A copy of the fields the app uses from the core's `src/contracts/environment.ts` (openspec changes
 * `add-tensorrt-llm-linux`, `add-tensorrt-llm-windows`); snake_case because the core emits them so. Nothing here is computed by
 * the app: every value comes from the core, over `atomic_core_call` or a relayed event.
 */

export type Sha256Digest = `sha256:${string}`

export type ManagedPhase =
  | 'checking'
  | 'awaiting-consent'
  | 'preparing-host'
  | 'relogin-required'
  | 'reboot-required'
  | 'preparing-environment'
  | 'pulling-image'
  | 'verifying'
  | 'activating'
  | 'removing'
  | 'ready'
  | 'removed'
  | 'cancelling'
  | 'cancelled'
  | 'failed'

export type ManagedAvailability =
  | 'supported'
  | 'setup-required'
  | 'prerequisite-blocked'
  | 'unsupported'

export type ManagedOperationKind = 'setup' | 'update' | 'remove'

export type ManagedOperationTarget =
  | { kind: 'environment' }
  | { kind: 'runtime'; installation_id: string; engine_id: string }

/** The core's error shape, as it arrives in an operation or a verdict. */
export interface ManagedError {
  code: string
  message: string
  details?: string
}

export interface ManagedProgress {
  label: string
  completed: number | null
  total: number | null
  unit: 'bytes' | 'steps' | 'unknown'
}

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
  status: 'absent' | 'installing' | 'ready' | 'updating' | 'removing' | 'failed'
}

export interface ManagedBlocker extends ManagedError {
  reason?: string
  params?: Record<string, string>
  commands?: string[]
}

/** Atomic Chat's own WSL distribution, once imported (Windows only). */
export interface WslDistribution {
  name: string
  /** The Windows folder that holds its `ext4.vhdx`. */
  path: string
  /** What the distribution takes on disk; null when the core could not read it. */
  size_bytes: number | null
}

export interface EnvironmentSnapshot {
  schema_version: 1
  environment_id: string
  instance_id: string
  revision: number
  /** `wsl-docker` on Windows: Docker inside Atomic Chat's WSL distribution. */
  executor: 'linux-docker' | 'wsl-docker'
  availability: ManagedAvailability
  gpus: GpuFacts[]
  blockers: ManagedBlocker[]
  selinux: boolean | null
  installations: RuntimeInstallation[]
  active_operation_id: string | null
  minimum_app_version: string | null
  /** Null before the import and always on Linux; absent from a core built before Windows. */
  distribution?: WslDistribution | null
  /**
   * Environment variables that move where the core reads conf or keeps its managed state, as the
   * core's process sees them (core 0.9.6+; absent from an older core). A machine that carries one
   * says so on the provider page: a pinned descriptor URL silently hides every newer descriptor.
   */
  source_overrides?: EnvironmentSourceOverride[]
}

export interface EnvironmentSourceOverride {
  variable: string
  value: string
}

/** `POST /environments/:id/reset`: the finished operations the core archived. */
export interface EnvironmentResetResult {
  environment_id: string
  archived_operation_ids: string[]
  archive_path: string | null
}

export interface ContainerRuntimeStepParameters {
  user: string
  arch: 'x86_64' | 'aarch64'
  family: 'apt' | 'dnf'
  distro_id: string
  version_id: string
  components: string[]
}

/** `windows.enable-wsl` takes nothing: its executor only runs `wsl --install --no-distribution`. */
export type EnableWslStepParameters = Record<string, never>

/** Each privileged action with the parameters the core sends for it. */
export interface ManagedHostStepParameters {
  'linux.install-container-runtime': ContainerRuntimeStepParameters
  'windows.enable-wsl': EnableWslStepParameters
}

export type ManagedHostAction = keyof ManagedHostStepParameters

export type ManagedHostStep = {
  [Action in ManagedHostAction]: {
    step_id: string
    action: Action
    recipe_id: string
    recipe_digest: Sha256Digest
    parameters_digest: Sha256Digest
    parameters: ManagedHostStepParameters[Action]
    nonce: string
    expected_operation_revision: number
  }
}[ManagedHostAction]

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
  carried_plan_digest: Sha256Digest | null
  progress: ManagedProgress | null
  pending_host_step: ManagedHostStep | null
  completed_step_ids: string[]
  cancellation_requested: boolean
  error: ManagedError | null
}

export interface ManagedSystemChange {
  code: string
  text: string
  params?: Record<string, string>
}

/**
 * Something the plan's reader should know that neither blocks the plan nor is fixed by it (core
 * task 2.23): `docker-address-pools-overlap-routes` — the host's routes (a VPN, usually) cover every
 * default Docker address pool, so Docker may not start; `params.routes` and `params.devices` name
 * them. Not part of `plan_digest`.
 */
export interface ManagedPlanWarning {
  code: string
  text: string
  params?: Record<string, string>
}

export interface RequirementPlan {
  plan_digest: Sha256Digest
  environment_id: string
  target: ManagedOperationTarget
  availability: ManagedAvailability
  recipe_id: string
  recipe_digest: Sha256Digest
  descriptor_id: string | null
  image_digest: Sha256Digest | null
  adopts_existing_engine: boolean
  system_changes: ManagedSystemChange[]
  download_bytes: number | null
  required_disk_bytes: number | null
  requires_elevation: boolean
  may_require_relogin: boolean
  may_require_reboot: boolean
  blockers: ManagedBlocker[]
  /**
   * The path the core measured free space for (`DockerRootDir`, or `/var/lib/docker` where Docker
   * does not answer yet) and the free bytes there as of this probe — the same number an
   * `insufficient-disk` blocker carries. Both null when the core measured nothing (the read failed,
   * a removal, no descriptor). Core task 2.22; the NVIDIA notices come from the descriptor route.
   * On Windows the path is the distribution's folder under `%LOCALAPPDATA%` and the space is on its
   * volume — once imported, the smaller of that and the guest's (core ruling 2.1).
   */
  docker_root_dir: string | null
  free_disk_bytes: number | null
  /** Shown before consent, never blocking it (core task 2.23). Empty when there are none. */
  warnings: ManagedPlanWarning[]
}

/** One file of a checkpoint as `check` and `model.yml` list it; `sha256` only for LFS files. */
export interface CheckpointFile {
  path: string
  size: number
  sha256: string | null
}

/** The core's verdict of `POST /models/tensorrt-llm/check` (spec `tensorrt-llm-models`). */
export interface ModelCompatibility {
  architectures: string[]
  quantization_format: string | null
  weight_bytes: number
  checked_gpu_id: string
  curated: boolean
  unified_memory: boolean
  fits_other_gpus: string[]
  kv_reserve_basis?: 'config' | 'weight_fraction'
  verdict: { ok: true } | { ok: false; error: ManagedError }
  /**
   * What the person should know about a model that can run, never a refusal (core ruling 2.8):
   * `wsl-vm-memory` on Windows when the WSL VM has less memory than the weights. Absent from a core
   * built before Windows and always on Linux.
   */
  warnings?: CompatibilityWarning[]
}

export interface CompatibilityWarning {
  code: string
  message: string
  params?: Record<string, string>
}

/** One checkpoint the engine release was qualified against (the descriptor's `curated_models`). */
export interface CuratedModel {
  repository: string
  revision: string
  inventory_digest: Sha256Digest
  vram_tier_bytes: number
  note: string
}

/**
 * `GET /environments/descriptors/:descriptorId` (core task 2.22): the part of one cached descriptor
 * a client shows — NVIDIA notices before consent, curated checkpoints on the model screen.
 */
export interface DescriptorSummary {
  descriptor_id: string
  engine_id: string
  notices: string[]
  curated_models: CuratedModel[]
  supported_architectures: string[]
}
