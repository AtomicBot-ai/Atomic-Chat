/**
 * Diffusion Service Types
 *
 * The seam between the Images (and later Video) pages and the native
 * `tauri-plugin-atomic-diffusion` plugin, which supervises a resident
 * `sd-server` (stable-diffusion.cpp) process, runs generation jobs against its
 * `/sdcpp/v1/*` API, and owns the gallery on disk.
 *
 * This file is the contract for three implementations that are written
 * against it independently: the Rust plugin (command names, argument names and
 * payload shapes — all camelCase over the bridge), `TauriDiffusionService`, and
 * the UI. Change it deliberately.
 *
 * Model *downloads* are not part of this seam: they go through the ordinary
 * `download-extension` pipeline (`lib/diffusion/models.ts`), and the plugin is
 * handed explicit file paths at load time. It never resolves the catalog.
 */

/** Which native engine serves generation. `diffusers` arrives in phase 1b. */
export type DiffusionEngineId = 'sd-cpp' | 'diffusers'

/** ggml/torch compute backend the engine build was made for. */
export type DiffusionBackend = 'cpu' | 'metal' | 'cuda' | 'vulkan' | 'rocm'

/**
 * Where the model weights live while generating. Mirrors Studio's diffusers
 * memory policies; on sd.cpp `group` → `--offload-to-cpu --diffusion-fa`,
 * `model` → also `--clip-on-cpu --vae-on-cpu --vae-tiling`.
 */
export type DiffusionOffloadPolicy = 'none' | 'group' | 'model'

/** Model family ids. The catalog (`atomic-chat-conf/models/diffusion.json`) is keyed on these. */
export type DiffusionFamilyId =
  | 'z-image'
  | 'flux.2-klein'
  | 'flux.1'
  | 'qwen-image'
  | 'wan2.2-ti2v-5b'
  | 'ltx-2'

export type DiffusionModality = 'image' | 'video'

/** Text-encoder slot, i.e. the sd-cli flag the file is passed under. */
export type DiffusionTextEncoderField = 'llm' | 'qwen2vl' | 'clip_l' | 't5xxl'

/**
 * Resolved on-disk files for one checkpoint, handed to `load_diffusion_model`.
 * Absolute paths. Only `diffusionModel` is required.
 */
export type DiffusionModelFiles = {
  diffusionModel: string
  vae?: string
  /** `flux2` for the FLUX.2 VAE; omitted otherwise. */
  vaeFormat?: string
  clipL?: string
  t5xxl?: string
  llm?: string
  qwen2vl?: string
}

/**
 * Per-family generation defaults the plugin needs at load time so that the
 * OpenAI facade (which has no knobs for steps/guidance) and request validation
 * can work without the catalog.
 */
export type DiffusionFamilyDefaults = {
  steps: number
  cfgScale: number
  /** FLUX-style distilled guidance; omitted for families without it. */
  guidance?: number
  samplingMethod?: string
  flowShift?: number
  width: number
  height: number
}

export type DiffusionFamilyRanges = {
  steps: [number, number]
  /** Inclusive min/max for both width and height. */
  dims: [number, number]
  dimMultiple: number
}

export type LoadDiffusionModelRequest = {
  /** `<family>:<quantId>`, e.g. `z-image:q4_k_m`. Shown in status and recipes. */
  modelId: string
  family: DiffusionFamilyId
  modality: DiffusionModality
  /** Display name for status and the OpenAI facade's `model` echo. */
  displayName: string
  files: DiffusionModelFiles
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
  offload: DiffusionOffloadPolicy
  /** Force a specific engine; omit for the plugin's own pick. */
  engine?: DiffusionEngineId
  /** Optional `--threads` for CPU backends. */
  threads?: number
  /** Seconds to wait for the model to load before giving up. Default 600. */
  startupTimeoutSecs?: number
}

export type DiffusionEngineInstall =
  | { state: 'not-installed' }
  | {
      state: 'installed'
      engine: DiffusionEngineId
      backend: DiffusionBackend
      /** Upstream release tag, e.g. `master-849-d04e895`. */
      tag: string
      /** Manifest backend id, e.g. `macos-arm64`, `win-cuda12-x64`. */
      backendId: string
      /** Absolute directory holding `sd-server`. */
      dir: string
    }

export type DiffusionModelState = 'unloaded' | 'loading' | 'loaded' | 'unloading' | 'failed'

export type LoadedDiffusionModel = {
  modelId: string
  family: DiffusionFamilyId
  modality: DiffusionModality
  displayName: string
  engine: DiffusionEngineId
  backend: DiffusionBackend
  offload: DiffusionOffloadPolicy
  /** True after the ggml-abort recovery respawned the server on the CPU backend. */
  cpuFallback: boolean
  port: number
  pid: number
  loadedAtMs: number
}

/** Native error codes, SCREAMING_SNAKE from the plugin. */
export type NativeDiffusionErrorCode =
  | 'ENGINE_MISSING'
  | 'ENGINE_INSTALL_FAILED'
  | 'ENGINE_CRASHED'
  | 'MODEL_MISSING'
  | 'SIDE_FILE_MISSING'
  | 'MODEL_LOAD_FAILED'
  | 'MODEL_INCOMPATIBLE'
  | 'MODEL_NOT_LOADED'
  | 'OUT_OF_MEMORY'
  | 'UNSUPPORTED_BACKEND'
  | 'UNSUPPORTED_WORKFLOW'
  | 'INVALID_DIMENSIONS'
  | 'INVALID_REQUEST'
  | 'JOB_BUSY'
  | 'JOB_NOT_FOUND'
  | 'QUEUE_FULL'
  | 'CANCELLED'
  | 'DISK_FULL'
  | 'BACKEND_IN_USE'
  | 'NOT_CONFIGURED'
  | 'INTERNAL'

export type DiffusionError = {
  code: NativeDiffusionErrorCode
  message: string
  details?: string
}

export type DiffusionStatus = {
  /** False on hosts the plugin refuses outright (e.g. no data folder configured yet). */
  configured: boolean
  install: DiffusionEngineInstall
  model: {
    state: DiffusionModelState
    loaded: LoadedDiffusionModel | null
    error?: DiffusionError
  }
  /** A queued or generating job, so a reload/navigation can adopt it. */
  activeJob: ImageJob | null
  outputDir: string
  /** Idle-unload timer, seconds; 0 = never. */
  idleUnloadSecs: number
}

/**
 * What the loaded model can do. Read after a successful load; the UI gates the
 * form on this and never hardcodes engine behaviour.
 */
export type ImageCapabilities = {
  workflows: ImageWorkflowId[]
  minDim: number
  maxDim: number
  dimMultiple: number
  supportsNegativePrompt: boolean
  supportsGuidance: boolean
  /** Whether a running generation can be cancelled without killing the server. */
  cancelGenerating: boolean
  maxBatch: number
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
}

export type ImageWorkflowId = 'create' | 'transform'

export type ImageGenerateRequest = {
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  steps: number
  /** Classifier-free guidance (`cfg_scale`). */
  cfgScale: number
  /** FLUX distilled guidance; ignored by families without it. */
  guidance?: number
  /** Omit or pass a negative value to let the engine draw one; the recipe records the seed used. */
  seed?: number
  /** Images per job (sd-server `batch_count`); 1..maxBatch. */
  batchSize: number
  samplingMethod?: string
  flowShift?: number
  workflow?: ImageWorkflowId
  /** `transform` only: absolute path of the source image and denoise strength 0..1. */
  initImagePath?: string
  strength?: number
}

export type ImageJobState = 'queued' | 'generating' | 'completed' | 'failed' | 'cancelled'

export type ImageJobPhase = 'queued' | 'encoding' | 'sampling' | 'decoding' | 'saving'

export type ImageJobProgress = {
  phase: ImageJobPhase
  /** Current sampling step and total, 0/0 until the first step line arrives. */
  step: number
  totalSteps: number
  /** 0..1 overall estimate for the job. */
  fraction: number
  etaSeconds: number | null
  /** Which image of the batch is being sampled, 0-based. */
  batchIndex: number
  batchSize: number
  elapsedMs: number
}

export type ImageJob = {
  id: string
  state: ImageJobState
  modelId: string
  request: ImageGenerateRequest
  createdAtMs: number
  startedAtMs?: number
  finishedAtMs?: number
  progress: ImageJobProgress | null
  /** Filled on completion (or per image as they land). */
  outputs: GalleryImageItem[]
  error?: DiffusionError
}

/**
 * The generation recipe, embedded verbatim in the PNG (`tEXt` chunk `atomic`)
 * and returned with every gallery item. Enough to reproduce the image.
 */
export type ImageRecipe = {
  jobId: string
  /** 0-based index inside the batch. */
  index: number
  prompt: string
  negativePrompt: string | null
  width: number
  height: number
  steps: number
  cfgScale: number
  guidance: number | null
  /** The seed this image was actually sampled with (`batchSeed + index`). */
  seed: number
  /** The seed the batch was requested with; restore this, not `seed`. */
  batchSeed: number
  batchSize: number
  samplingMethod: string | null
  flowShift: number | null
  workflow: ImageWorkflowId
  strength: number | null
  model: {
    modelId: string
    family: DiffusionFamilyId
    displayName: string
    /** Basename of the transformer file, so two quants of one repo stay distinguishable. */
    filename: string
  }
  engine: {
    kind: DiffusionEngineId
    backend: DiffusionBackend
    tag: string
    offload: DiffusionOffloadPolicy
    cpuFallback: boolean
  }
  createdAtMs: number
  durationMs: number
}

export type GalleryImageItem = {
  /** `<jobId>-<index:02>`; also the file stem. */
  id: string
  /** Absolute PNG path under the output dir. */
  path: string
  /** Absolute path of the 256 px PNG thumbnail (`<id>.thumb.png`), or null when it could not be written. */
  thumbnailPath: string | null
  width: number
  height: number
  sizeBytes: number
  createdAtMs: number
  pinned: boolean
  archived: boolean
  recipe: ImageRecipe
}

export type GalleryPage = {
  items: GalleryImageItem[]
  hasMore: boolean
  total: number
}

export type GalleryListOptions = {
  offset: number
  limit: number
  /** Default false: archived items are hidden. */
  includeArchived?: boolean
}

export type GalleryFlags = {
  pinned?: boolean
  archived?: boolean
}

/** A file the plugin found under `<dataFolder>/diffusion/models`. */
export type DiffusionModelFile = {
  /** Absolute path. */
  path: string
  /** Path relative to the models root, `/`-separated, e.g. `z-image/z-image-turbo-Q4_K_M.gguf`. */
  relativePath: string
  bytes: number
}

export type DiffusionBackendInstallRecord = {
  tag: string
  backendId: string
  backend: DiffusionBackend
  engine: DiffusionEngineId
  sha256: string | null
  installedAtMs: number
  dir: string
}

/** One-time plugin configuration, sent when the web app binds the service. */
export type DiffusionConfig = {
  /** The app data folder; the plugin derives `diffusion/`, `images/`, `videos/` from it. */
  dataFolder: string
  /** Override for the gallery output dir; omit for `<dataFolder>/images`. */
  outputDir?: string
  /** 0 = never unload on idle. */
  idleUnloadSecs?: number
}

export type DiffusionEvent =
  | { type: 'state'; status: DiffusionStatus; reason?: string }
  | { type: 'progress'; jobId: string; progress: ImageJobProgress }
  | { type: 'job'; job: ImageJob }
  | {
      type: 'error'
      jobId?: string
      code: NativeDiffusionErrorCode
      message: string
      details?: string
    }

/**
 * Plugin command surface. Every method maps 1:1 onto
 * `invoke('plugin:atomic-diffusion|<snake_case name>')`.
 */
export interface DiffusionService {
  /** True when this build ships the native plugin at all. */
  isSupported(): boolean

  /** Must be called once before anything else; idempotent. */
  configure(config: DiffusionConfig): Promise<DiffusionStatus>
  getStatus(): Promise<DiffusionStatus>

  // --- engine binary --------------------------------------------------------
  /**
   * Called after the archive has been downloaded and decompressed into `dir`:
   * sets the executable bits, writes the ownership marker and install record,
   * and probes `sd-cli --help` to make sure this really is stable-diffusion.cpp.
   */
  finalizeBackendInstall(args: {
    dir: string
    tag: string
    backendId: string
    backend: DiffusionBackend
    engine: DiffusionEngineId
    sha256?: string
  }): Promise<DiffusionBackendInstallRecord>
  listInstalledBackends(): Promise<DiffusionBackendInstallRecord[]>
  /** Refuses (`BACKEND_IN_USE`) while a session runs from that tree, and refuses trees without the ownership marker. */
  removeBackend(dir: string): Promise<void>

  // --- model files ---------------------------------------------------------
  listModelFiles(): Promise<DiffusionModelFile[]>
  /** Only paths under the models root. */
  deleteModelFile(path: string): Promise<void>

  // --- session -------------------------------------------------------------
  loadModel(request: LoadDiffusionModelRequest): Promise<LoadedDiffusionModel>
  unloadModel(): Promise<void>
  getCapabilities(): Promise<ImageCapabilities>
  /** Reset the idle-unload deadline without generating. */
  touchIdle(): Promise<void>

  // --- jobs ----------------------------------------------------------------
  generate(request: ImageGenerateRequest): Promise<{ jobId: string }>
  getJob(jobId: string): Promise<ImageJob | null>
  /**
   * Cancel a job. A queued job cancels natively. A generating job on an engine
   * without `cancelGenerating` is stopped by killing the server after a short
   * grace period; the next `generate` respawns it transparently.
   */
  cancelJob(jobId: string): Promise<{ cancelled: boolean; serverStopped: boolean }>

  // --- gallery -------------------------------------------------------------
  listGallery(options: GalleryListOptions): Promise<GalleryPage>
  getGalleryItem(id: string): Promise<GalleryImageItem | null>
  deleteGalleryItems(ids: string[]): Promise<void>
  setGalleryFlags(id: string, flags: GalleryFlags): Promise<GalleryImageItem>
  /** Byte-for-byte copy to `targetPath`, keeping the embedded recipe. */
  exportGalleryItem(id: string, targetPath: string): Promise<void>
  setOutputDir(path: string): Promise<DiffusionStatus>

  /** Subscribe to plugin events. Returns an unsubscribe function. */
  subscribe(handler: (event: DiffusionEvent) => void): () => void
}
