/**
 * The core's embedding module as the app sees it: `/atomic/v1/embedding/*`
 * (ADR 2026-10-07-embedding-models-are-their-own-core-module in
 * atomic-chat-core). Bodies are snake_case, verbatim from the core.
 */

export type EmbeddingState =
  | 'disabled'
  | 'idle'
  | 'starting'
  | 'ready'
  | 'restarting'
  | 'failed'
  | 'unsupported'

/** What one input may hold, as the running process reports it. */
export type EmbeddingModality = 'text' | 'image' | 'audio' | 'video'

export type EmbeddingCoreError = {
  code: string
  message: string
  details?: string
}

export type EmbeddingEngineInfo = {
  path: string
  /** `<version>/<backend>` of the installed pack; `null` for an explicit `engine_path`. */
  version_backend: string | null
  /** The provider whose pack runs it; `null` for an explicit `engine_path`. */
  provider: 'llamacpp-upstream' | null
}

export type EmbeddingStatus = {
  state: EmbeddingState
  enabled: boolean
  /** Resolved absolute model path, or `null` when none is configured. */
  model_path: string | null
  /** The name API clients pass as `model`, or `null` when no model is configured. */
  model_id: string | null
  engine: EmbeddingEngineInfo | null
  pid: number | null
  port: number | null
  /** Length of the vectors the running process returns; `null` until it is ready. */
  dims: number | null
  /** What one input may hold; `[]` until the process is ready. */
  modalities: EmbeddingModality[]
  restarts: number
  error: EmbeddingCoreError | null
  since: number
}

export type EmbeddingConfig = {
  enabled: boolean
  /** The embedding GGUF; relative to the data folder, or absolute. */
  model_path: string
  /** `--mmproj` of a model that reads images or audio; empty for none. */
  mmproj_path: string
  /** `-a`: the name API clients pass as `model`; empty = the file name. */
  model_id: string
  /** `-c`, `-b` and `-ub`; 0 lets the core pick. */
  ctx_size: number
  /** `--pooling`; empty = the model's own. */
  pooling: '' | 'mean' | 'cls' | 'last'
  /** `--image-max-tokens`; 0 = the engine's own. */
  image_max_tokens: number
  threads: number
  idle_unload_secs: number
  startup_timeout_secs: number
  engine_path: string
}

/** `GET` / `PUT /embedding/config`. */
export type EmbeddingConfigAnswer = {
  config: EmbeddingConfig
  status: EmbeddingStatus
}

/** `POST /embedding/embed`: what the engine answered, relayed as it came. */
export type EmbeddingEmbedResponse = {
  /** The engine's HTTP status. */
  status: number
  /** The engine's JSON answer (the OpenAI list, or its error envelope). */
  body: unknown
}

export type EmbeddingEvent =
  | { type: 'state'; status: EmbeddingStatus }
  | { type: 'error'; error: EmbeddingCoreError }
  /** A new core attached: re-read the status. */
  | { type: 'reset' }

export interface EmbeddingService {
  /** False off the desktop: there is no core to run the model. */
  isSupported(): boolean
  getStatus(): Promise<EmbeddingStatus>
  getConfig(): Promise<EmbeddingConfigAnswer>
  setConfig(patch: Partial<EmbeddingConfig>): Promise<EmbeddingConfigAnswer>
  /** Start now and resolve once ready; a failure rejects with the core's `{code, message}`. */
  load(): Promise<EmbeddingStatus>
  unload(): Promise<EmbeddingStatus>
  /** One OpenAI embeddings body (`{input, ...}`); the core fills in `model`. */
  embed(request: Record<string, unknown>): Promise<EmbeddingEmbedResponse>
  subscribe(handler: (event: EmbeddingEvent) => void): () => void
}
