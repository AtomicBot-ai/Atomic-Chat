/**
 * Diffusion Service Types
 *
 * The seam between the Images (and later Video) pages and the core's image
 * generation (`atomic-chat-core`, `src/diffusion/`), which supervises a
 * resident `sd-server` (stable-diffusion.cpp) process, runs generation jobs
 * against its `/sdcpp/v1/*` API, and owns the gallery on disk.
 *
 * This file is the contract for three implementations that are written
 * against it independently: the core (`src/contracts/diffusion.ts` mirrors it
 * field for field; the routes under `/atomic/v1/diffusion/*` take these shapes
 * as camelCase bodies), `TauriDiffusionService`, and the UI. Change it
 * deliberately.
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
  | 'flux.1-uncensored'
  | 'flux.1-abliterated'
  | 'flux.1-nsfw-realism'
  | 'flux.1-krea'
  | 'krea-2-turbo'
  | 'qwen-image'
  | 'qwen-image-2.1'
  | 'wan2.2-ti2v-5b'
  | 'ltx-2'

export type DiffusionModality = 'image' | 'video'

/** Text-encoder slot, i.e. the sd-cli flag the file is passed under. */
export type DiffusionTextEncoderField =
  | 'llm'
  | 'llm_vision'
  | 'qwen2vl'
  | 'clip_l'
  | 't5xxl'
  /** LTX-2.3's text-embedding connectors, passed to sd.cpp as `--embeddings-connectors`. */
  | 'embeddings_connectors'

/**
 * Resolved on-disk files for one checkpoint, handed to `loadModel`.
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
  /** Qwen/other VLM vision projector, passed to sd.cpp as `--llm_vision`. */
  llmVision?: string
  qwen2vl?: string
  /** LTX-2: the audio VAE, passed to sd.cpp as `--audio-vae`. */
  audioVae?: string
  /** LTX-2.3: the text-embedding connectors, passed to sd.cpp as `--embeddings-connectors`. */
  embeddingsConnectors?: string
}

/** What a video family generates by default; present on every video load, absent on image loads. */
export type DiffusionVideoDefaults = {
  /** Frames per second the model was trained at; a request naming another rate is refused. */
  fps: number
  /** Default frame count; itself on the lattice `k * frameStep + frameOffset`. */
  frames: number
  /** Valid frame counts are `k * frameStep + frameOffset` (LTX-2: 8k+1, Wan: 4k+1). */
  frameStep: number
  frameOffset: number
  /** The sizes the family was trained for: the Resolution picker, never a hard limit. */
  resolutionPresets: [number, number][]
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
  /** A distilled model's fixed sigma schedule; the core sends it as `custom_sigmas` when `steps` equals its length. */
  sigmas?: number[]
  video?: DiffusionVideoDefaults
}

export type DiffusionFamilyRanges = {
  steps: [number, number]
  /** Inclusive min/max for both width and height. */
  dims: [number, number]
  dimMultiple: number
  /** Video only: inclusive min/max frame count. */
  frames?: [number, number]
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

export type DiffusionModelState =
  | 'unloaded'
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'failed'

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

/** Native error codes, SCREAMING_SNAKE from the core (`DiffusionErrorCode` there). */
export type NativeDiffusionErrorCode =
  | 'ENGINE_MISSING'
  | 'ENGINE_UPDATE_REQUIRED'
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
  | 'INVALID_OUTPUT'
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
  /** A queued or generating image job, so a reload/navigation can adopt it. */
  activeJob: ImageJob | null
  /** The video counterpart; at most one of the two is set. */
  activeVideoJob: VideoJob | null
  outputDir: string
  videoOutputDir: string
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

/**
 * What a request does with its images. Every workflow is served by the one
 * `img_gen` endpoint; the body just carries different inputs. Order and
 * labels live in `lib/diffusion/workflows.ts`.
 */
export type ImageWorkflowId =
  | 'create'
  | 'transform'
  | 'inpaint'
  | 'extend'
  | 'upscale'
  | 'reference'
  | 'edit'

/**
 * One image input: a file the user picked (the plugin reads it) or PNG bytes
 * the web app produced itself (a painted mask, a grown canvas). A data URL
 * prefix is accepted on `base64`.
 */
export type ImageSource = { path: string } | { base64: string }

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
  /** Source image for every workflow but `create`; the reference workflows send it as the first reference. */
  initImage?: ImageSource
  /** `inpaint` / `extend`: white where the model repaints. */
  maskImage?: ImageSource
  /** `reference`: extra references after the source, at most three. */
  referenceImages?: ImageSource[]
  /** Denoise strength 0..1 for transform / inpaint / extend / upscale. */
  strength?: number
}

export type ImageJobState =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled'

export type ImageJobPhase =
  | 'queued'
  | 'encoding'
  | 'sampling'
  | 'decoding'
  | 'postprocessing'
  | 'saving'

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

/**
 * The core's image-generation configuration. It lives only in the core's
 * memory and each `configure` replaces all of it, so the app sends every
 * setting each time: on bind, on a settings change and on every
 * `atomic-core://snapshot`.
 */
export type DiffusionConfig = {
  /** The app data folder, which must be the core's own; `diffusion/` and `images/` live in it. */
  dataFolder: string
  /** Override for the gallery output dir; omit for `<dataFolder>/images`. */
  outputDir?: string
  /** Override for the video folder; omit for `<dataFolder>/videos`. */
  videoOutputDir?: string
  /** 0 = never unload on idle. */
  idleUnloadSecs?: number
}

// ---------------------------------------------------------------------------
// Video generation. The same engine and session; its own request, job, recipe
// and gallery item, mirrored field for field from the core's
// `src/contracts/diffusion.ts`, so the image types above keep their shape.
// ---------------------------------------------------------------------------

/** `image-to-video` is reserved: parsed and recorded by the core, refused until the workflow lands. */
export type VideoWorkflowId = 'create' | 'image-to-video'

export type VideoJobState = ImageJobState
export type VideoJobPhase = ImageJobPhase

/** The one container sd.cpp writes that the webview plays: VP8 in WebM. */
export type VideoOutputFormat = 'webm'

/** What the loaded video model can do; the Video page gates its form on this. */
export type VideoCapabilities = {
  workflows: VideoWorkflowId[]
  minDim: number
  maxDim: number
  dimMultiple: number
  supportsNegativePrompt: boolean
  supportsGuidance: boolean
  /** Whether a running generation can be cancelled without stopping the server. */
  cancelGenerating: boolean
  fps: number
  frames: { min: number; max: number; step: number; offset: number; default: number }
  resolutionPresets: [number, number][]
  outputFormat: VideoOutputFormat
  /** From the engine's `output_formats_by_mode.vid_gen`; null when the build did not report formats. */
  webmSupported: boolean | null
  defaults: DiffusionFamilyDefaults
  ranges: DiffusionFamilyRanges
}

export type VideoGenerateRequest = {
  prompt: string
  negativePrompt?: string
  width: number
  height: number
  /** Omit for the family default. Must be `k * frameStep + frameOffset` within `ranges.frames`. */
  frames?: number
  /** Omit for the family rate; any other value is refused. */
  fps?: number
  steps: number
  cfgScale: number
  guidance?: number
  /** Omit or pass a negative value to let the core draw one; the recipe records the seed used. */
  seed?: number
  samplingMethod?: string
  flowShift?: number
  workflow?: VideoWorkflowId
  /** Reserved for `image-to-video`: the first frame. */
  initImage?: ImageSource
  /** Reserved for `image-to-video`: the last frame. */
  endImage?: ImageSource
}

/** One clip per job, so no batch fields. */
export type VideoJobProgress = {
  phase: VideoJobPhase
  step: number
  totalSteps: number
  /** 0..1 overall estimate for the job. */
  fraction: number
  etaSeconds: number | null
  elapsedMs: number
}

export type VideoJob = {
  id: string
  state: VideoJobState
  modelId: string
  request: VideoGenerateRequest
  createdAtMs: number
  startedAtMs?: number
  finishedAtMs?: number
  progress: VideoJobProgress | null
  /** Zero or one item. */
  outputs: GalleryVideoItem[]
  error?: DiffusionError
}

/** Written as `<jobId>.json` beside the clip and returned with every gallery item. Enough to reproduce the clip. */
export type VideoRecipe = {
  jobId: string
  prompt: string
  negativePrompt: string | null
  width: number
  height: number
  /** The frame count that was requested and validated. */
  frames: number
  /** The frame count the engine reported for the file it wrote, after its own normalisation. */
  frameCount: number
  fps: number
  steps: number
  cfgScale: number
  guidance: number | null
  seed: number
  samplingMethod: string | null
  flowShift: number | null
  workflow: VideoWorkflowId
  outputFormat: VideoOutputFormat
  model: {
    modelId: string
    family: DiffusionFamilyId
    displayName: string
    /** Basename of the transformer file. */
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

export type GalleryVideoItem = {
  /** The job id (32 hex characters); also the file stem. */
  id: string
  /** Absolute WebM path under the video output dir. */
  path: string
  /** `<id>.thumb.png`, once the app uploaded a poster; null until then. */
  posterPath: string | null
  width: number
  height: number
  fps: number
  frameCount: number
  /** `frameCount / fps`. */
  durationSecs: number
  sizeBytes: number
  createdAtMs: number
  pinned: boolean
  archived: boolean
  recipe: VideoRecipe
}

export type VideoGalleryPage = {
  items: GalleryVideoItem[]
  hasMore: boolean
  total: number
}

export type DiffusionEvent =
  | { type: 'state'; status: DiffusionStatus; reason?: string }
  | { type: 'progress'; jobId: string; progress: ImageJobProgress }
  | { type: 'job'; job: ImageJob }
  /** The video runner's own two; `state` and `error` are shared with images. */
  | { type: 'video-progress'; jobId: string; progress: VideoJobProgress }
  | { type: 'video-job'; job: VideoJob }
  | {
      type: 'error'
      jobId?: string
      code: NativeDiffusionErrorCode
      message: string
      details?: string
    }
  /**
   * The core generation that held the configuration is gone and a new one
   * attached (the desktop seam raises this from the relay's snapshot): the
   * output folder and idle interval have to be sent again.
   */
  | { type: 'reset'; generation: number | null }

/**
 * The service surface. Every method maps 1:1 onto one core control route
 * (`TauriDiffusionService` names them).
 */
export interface DiffusionService {
  /** True when this build ships the native plugin at all. */
  isSupported(): boolean

  /** Must be called before anything else; idempotent, and replaces the whole config. */
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
  cancelJob(
    jobId: string
  ): Promise<{ cancelled: boolean; serverStopped: boolean }>

  // --- gallery -------------------------------------------------------------
  listGallery(options: GalleryListOptions): Promise<GalleryPage>
  getGalleryItem(id: string): Promise<GalleryImageItem | null>
  deleteGalleryItems(ids: string[]): Promise<void>
  setGalleryFlags(id: string, flags: GalleryFlags): Promise<GalleryImageItem>
  /** Byte-for-byte copy to `targetPath`, keeping the embedded recipe. */
  exportGalleryItem(id: string, targetPath: string): Promise<void>
  setOutputDir(path: string): Promise<DiffusionStatus>

  // --- video: the same session, its own jobs, gallery and poster ------------
  /** Refused (`MODEL_INCOMPATIBLE`) while an image model is loaded. */
  getVideoCapabilities(): Promise<VideoCapabilities>
  generateVideo(request: VideoGenerateRequest): Promise<{ jobId: string }>
  getVideoJob(jobId: string): Promise<VideoJob | null>
  cancelVideoJob(
    jobId: string
  ): Promise<{ cancelled: boolean; serverStopped: boolean }>
  listVideoGallery(options: GalleryListOptions): Promise<VideoGalleryPage>
  getVideoGalleryItem(id: string): Promise<GalleryVideoItem | null>
  deleteVideoGalleryItems(ids: string[]): Promise<void>
  setVideoGalleryFlags(id: string, flags: GalleryFlags): Promise<GalleryVideoItem>
  /** Byte-for-byte copy of the WebM to `targetPath`; the recipe stays with the gallery. */
  exportVideoGalleryItem(id: string, targetPath: string): Promise<void>
  /** The poster the webview rendered from the clip's first frame: a PNG as base64 (a data-URL prefix is accepted). */
  setVideoPoster(id: string, pngBase64: string): Promise<GalleryVideoItem>

  /** Subscribe to plugin events. Returns an unsubscribe function. */
  subscribe(handler: (event: DiffusionEvent) => void): () => void
}
