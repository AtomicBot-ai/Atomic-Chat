/**
 * The core's decision module as the app sees it: `/atomic/v1/decision/*`
 * (ADR 2026-09-30-the-decision-model-is-its-own-core-module in
 * atomic-chat-core). Bodies are snake_case, verbatim from the core.
 */

export type DecisionState =
  | 'disabled'
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed'
  | 'unsupported'

export type DecisionCoreError = {
  code: string
  message: string
  details?: string
}

export type DecisionCheckpointInfo = {
  dir?: string
  cache_dir?: string
  key?: string
  outtype?: string
  cache_hit?: boolean
  convert_ms?: number
  converter?: number
}

/** `/props.decision` of the running process; only the fields the app reads are typed. */
export type DecisionProps = {
  api_version: number
  model_id?: string
  source?: 'gguf' | 'checkpoint-dir' | (string & {})
  cache_path?: string | null
  checkpoint?: DecisionCheckpointInfo | null
  router?: { available?: boolean; calibrated?: boolean }
  [extra: string]: unknown
}

export type DecisionEngineInfo = {
  path: string
  version_backend: string | null
  fork_version: string | null
  version_gate: boolean | null
  /** The API the engine runs: the fork's `--decision`, or stock llama.cpp's `/v1/systemone`. */
  dialect?: 'turboquant' | 'upstream'
  /** The provider whose pack runs it; `null` for an explicit `engine_path`. */
  provider?: 'llamacpp' | 'llamacpp-upstream' | null
}

export type DecisionStatus = {
  state: DecisionState
  enabled: boolean
  /** Resolved absolute model path, or `null` when none is configured. */
  model_path: string | null
  engine: DecisionEngineInfo | null
  pid: number | null
  port: number | null
  props: DecisionProps | null
  capabilities: string[]
  restarts: number
  error: DecisionCoreError | null
  since: number
}

export type DecisionConfig = {
  enabled: boolean
  /** A GGUF or a laya checkpoint folder; relative to the data folder. The file decides the engine. */
  model_path: string
  /** `--mmproj` of a stock llama.cpp model that reads images; empty for none. */
  mmproj_path: string
  /** `-c` of a stock llama.cpp model; 0 lets the core pick. */
  ctx_size: number
  model_id: string
  spec_path: string
  threads: number
  timeout_ms: number
  idle_unload_secs: number
  startup_timeout_secs: number
  allow_uncalibrated: boolean
  engine_path: string
  convert_type: 'f16' | 'f32'
}

/** `GET` / `PUT /decision/config`. */
export type DecisionConfigAnswer = {
  config: DecisionConfig
  status: DecisionStatus
}

export type DecisionQuestion = {
  type: 'noul' | 'choice' | 'score'
  instructions: string
  criteria?: Record<string, string | null>
  [extra: string]: unknown
}

/** `POST /decision/decide`. */
export type DecisionDecideRequest = {
  state: unknown
  questions: Record<string, DecisionQuestion>
  truncation?: 'allow' | 'error'
  timeout_ms?: number
}

/** What `decide` answers once the body parses: the engine's result, or why there is none. */
export type DecisionOutcome<T = unknown> =
  | { unavailable: false; result: T; elapsed_ms: number }
  | {
      unavailable: true
      reason: string
      message: string
      elapsed_ms: number
      status?: number
      error?: unknown
    }

export type DecisionEvent =
  | { type: 'state'; status: DecisionStatus }
  | { type: 'error'; error: DecisionCoreError }
  /** A new core attached: re-read the status. */
  | { type: 'reset' }

export interface DecisionService {
  /** False off the desktop: there is no core to run the model. */
  isSupported(): boolean
  getStatus(): Promise<DecisionStatus>
  getConfig(): Promise<DecisionConfigAnswer>
  setConfig(patch: Partial<DecisionConfig>): Promise<DecisionConfigAnswer>
  /** Start now and resolve once ready; a failure rejects with the core's `{code, message}`. */
  load(): Promise<DecisionStatus>
  unload(): Promise<DecisionStatus>
  decide(request: DecisionDecideRequest): Promise<DecisionOutcome>
  subscribe(handler: (event: DecisionEvent) => void): () => void
}
