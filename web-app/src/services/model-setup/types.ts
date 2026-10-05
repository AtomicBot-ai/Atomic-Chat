/**
 * The core's per-file compatibility verdict and its model setup operation, as
 * the app sees them: `POST /atomic/v1/models/compatibility`,
 * `POST /atomic/v1/models/setup-plan` and `/atomic/v1/model-setups*`
 * (atomic-chat-core `src/contracts/model-{compatibility,setup}.ts`). Bodies are
 * snake_case, verbatim from the core; only the fields the app reads are typed.
 */

export type CompatibilityOutcome =
  | 'compatible'
  | 'engine_required'
  | 'engine_update_required'
  | 'legacy_artifact'
  | 'inspection_required'
  | 'unsupported'

export type CompatibilityVerdict = {
  outcome: CompatibilityOutcome
  /** The provider the file must run on; `null` = any llama.cpp provider. */
  provider: string | null
  requires: string[]
  evidence: 'rules' | 'header' | 'none'
  rules_version: number
  min_prism_build?: number
  installed_prism_build?: number | null
  /** `legacy_artifact`: the file to get instead, in the same repository. */
  replacement?: string
  family?: string
  reason: string
}

export type ModelCompatibilityRequest = {
  model_id?: string
  repo?: string
  file?: string
  revision?: string
  sha256?: string
  inspect_remote?: boolean
  provider?: string
}

export type ModelSetupStage =
  | 'queued'
  | 'installing_engine'
  | 'downloading_model'
  | 'downloading_projector'
  | 'verifying'
  | 'registering'
  | 'ready'
  | 'failed'
  | 'cancelled'
  | 'interrupted'

/** Stages a setup never leaves on its own; `interrupted` waits for `resume`. */
export const MODEL_SETUP_FINAL_STAGES: readonly ModelSetupStage[] = [
  'ready',
  'failed',
  'cancelled',
]

export type ModelSetupArtifact = {
  repo: string
  file: string
  revision: string
  sha256?: string
  /** Bytes; `0` when the Hub did not say. */
  size: number
}

export type ModelSetupEngine = {
  provider: 'atomic-prism'
  version: string
  backend: string
  installed: boolean
  download_size: number
}

export type ModelSetupBlocker = {
  code:
    | 'unsupported'
    | 'legacy_artifact'
    | 'no_engine_build'
    | 'insufficient_disk_space'
    | (string & {})
  message: string
  replacement?: string
}

export type ModelSetupPlanRequest = {
  repo: string
  file: string
  revision?: string
  model_id?: string
  include_projector?: boolean
}

export type ModelSetupPlan = {
  digest: string
  model_id: string
  provider: string
  verdict: CompatibilityVerdict
  engine: ModelSetupEngine | null
  model: ModelSetupArtifact
  projector: ModelSetupArtifact | null
  total_download_bytes: number
  free_bytes: number | null
  blockers: ModelSetupBlocker[]
}

export type ModelSetupStartRequest = ModelSetupPlanRequest & {
  request_id: string
  plan_digest: string
}

export type ModelSetupError = {
  code: string
  message: string
  details?: string
}

export type ModelSetup = {
  setup_id: string
  request_id: string
  revision: number
  stage: ModelSetupStage
  request: ModelSetupPlanRequest
  plan: ModelSetupPlan
  task_ids: { engine?: string; model: string; projector?: string }
  stopped_at?: ModelSetupStage
  error?: ModelSetupError
  created_at: number
  updated_at: number
}

export type ModelSetupEvent =
  | { type: 'changed'; setup: ModelSetup }
  | { type: 'progress'; taskId: string; transferred: number; total: number }
  /** A core generation attached: every record must be read again. */
  | { type: 'reset' }

export interface ModelSetupService {
  /** `false` where there is no core (web, mobile): the Hub downloads as before. */
  isSupported(): boolean
  checkCompatibility(
    request: ModelCompatibilityRequest
  ): Promise<CompatibilityVerdict>
  plan(request: ModelSetupPlanRequest): Promise<ModelSetupPlan>
  start(request: ModelSetupStartRequest): Promise<ModelSetup>
  list(): Promise<ModelSetup[]>
  cancel(setupId: string): Promise<ModelSetup>
  resume(setupId: string): Promise<ModelSetup>
  subscribe(handler: (event: ModelSetupEvent) => void): () => void
}
