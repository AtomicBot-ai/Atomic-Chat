/**
 * Audio generation on the wire: speech, music and sound effects on audio.cpp,
 * one resident model per server process. A field-for-field mirror of the
 * core's `src/contracts/audio.ts` and its `AUDIO_ERROR_CODES`, camelCase like
 * the diffusion surface, plus the service the Audios studio calls.
 *
 * The core never downloads a model: a load names a file under
 * `<data>/audio/models` and the audio.cpp `family` and `task` it is served as,
 * which come from the audio catalog (`services/audio-catalog-registry.ts`).
 */

import type {
  EngineBuildCatalog,
  EngineBuildCatalogRequest,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
  EngineBuildRemoveResult,
  EngineBuildUpdateCheck,
  EngineBuildUpdateCheckRequest,
} from '@/services/engine-builds/types'

/** The engine-build id audio.cpp installs under (`/engine-builds/audio-cpp/*`). */
export const AUDIO_ENGINE_ID = 'audio-cpp'

/** What a model generates: the three modes of the Audios studio. */
export const AUDIO_MODES = ['speech', 'music', 'effects'] as const
export type AudioMode = (typeof AUDIO_MODES)[number]

/** The compute backend an audio.cpp build was made for (`--backend`). */
export const AUDIO_BACKENDS = ['cpu', 'metal', 'cuda', 'vulkan'] as const
export type AudioBackend = (typeof AUDIO_BACKENDS)[number]

/** audio.cpp's task for a model entry: `tts` for speech, `gen` for music and effects. */
export const AUDIO_TASKS = ['tts', 'gen'] as const
export type AudioTask = (typeof AUDIO_TASKS)[number]

/** The core's `AUDIO_ERROR_CODES`. */
export const AUDIO_ERROR_CODES = [
  'ENGINE_MISSING',
  'ENGINE_INSTALL_FAILED',
  'ENGINE_CRASHED',
  'MODEL_MISSING',
  'MODEL_LOAD_FAILED',
  /** The engine served something other than the family and task the load asked for. */
  'MODEL_INCOMPATIBLE',
  'MODEL_NOT_LOADED',
  'OUT_OF_MEMORY',
  'UNSUPPORTED_BACKEND',
  /** The loaded model serves another mode than the job asks for. */
  'UNSUPPORTED_MODE',
  'INVALID_REQUEST',
  /** audio.cpp refused the request; `details` carries its words. */
  'REQUEST_REJECTED',
  /** The engine answered with something that is not a WAV. */
  'INVALID_OUTPUT',
  'JOB_BUSY',
  'JOB_NOT_FOUND',
  'CANCELLED',
  'DISK_FULL',
  'BACKEND_IN_USE',
  'INTERNAL',
] as const
export type AudioErrorCode = (typeof AUDIO_ERROR_CODES)[number]

/** A value of an audio.cpp load, session or request option. */
export type AudioOptionValue = string | number | boolean

export type AudioOptions = Record<string, AudioOptionValue>

export type AudioModelState =
  | 'unloaded'
  | 'loading'
  | 'loaded'
  | 'unloading'
  | 'failed'

export type AudioJobState =
  | 'queued'
  | 'generating'
  | 'completed'
  | 'failed'
  | 'cancelled'

/**
 * audio.cpp reports no progress while it generates, so a job moves through
 * phases only: `loading` while a server stopped by a cancel or a crash comes
 * back, `generating` while the engine runs, `saving` while the WAV is written.
 */
export type AudioJobPhase = 'queued' | 'loading' | 'generating' | 'saving'

export interface LoadAudioModelRequest {
  /** The catalog's id, e.g. `moss-tts-nano-100m:q8_0`; also the server's model id. */
  modelId: string
  displayName: string
  mode: AudioMode
  /** The GGUF to serve: absolute, or relative to `<data>/audio/models`. */
  file: string
  /** audio.cpp's family, e.g. `moss_tts_nano`, `qwen3_tts`, `ace_step`, `stable_audio`. */
  family: string
  task: AudioTask
  /** `models[].load_options`. */
  loadOptions?: AudioOptions
  /** `models[].session_options`, family-prefixed keys as audio.cpp documents them. */
  sessionOptions?: AudioOptions
  /** `models[].default_request_options`: what every request starts from. */
  defaultRequestOptions?: AudioOptions
  /** A built-in voice the server uses when a request names none. */
  defaultVoice?: string
  /** `--threads`. */
  threads?: number
  /** Seconds to wait for the model to load. Default 600. */
  startupTimeoutSecs?: number
}

export type AudioEngineInstall =
  | { state: 'not-installed' }
  | {
      state: 'installed'
      backend: AudioBackend
      /** Release tag, e.g. `v0.9.3-a1b2c3d4`. */
      tag: string
      /** Manifest backend id, e.g. `macos-arm64`. */
      backendId: string
      /** Absolute directory holding `audiocpp_server`. */
      dir: string
    }

export interface LoadedAudioModel {
  modelId: string
  displayName: string
  mode: AudioMode
  family: string
  task: AudioTask
  backend: AudioBackend
  tag: string
  backendId: string
  port: number
  pid: number
  loadedAtMs: number
}

/** An audio failure as job records and events carry it. `details` is always a string. */
export interface AudioErrorBody {
  code: AudioErrorCode
  message: string
  details?: string
}

export interface AudioStatus {
  install: AudioEngineInstall
  model: {
    state: AudioModelState
    loaded: LoadedAudioModel | null
    error?: AudioErrorBody
  }
  /** A queued or generating job, so a reload can adopt it. */
  activeJob: AudioJob | null
  outputDir: string
  /** Idle-unload timer in seconds; 0 = never. */
  idleUnloadSecs: number
}

/** Optional settings; the module works with its defaults before any of them is sent. */
export interface AudioConfig {
  /** Override for the gallery folder; `null` goes back to `<data>/audios`. */
  outputDir?: string | null
  /** 0 = never unload on idle. Default 600. */
  idleUnloadSecs?: number
}

/** One request option a model declares, as audio.cpp writes it. */
export interface AudioModelParam {
  name: string
  type: string
  required: boolean
  description?: string
  default?: AudioOptionValue
  min?: number
  max?: number
  /** An enum's values, a preset's included. */
  values?: string[]
}

/** What the loaded model takes. */
export interface AudioCapabilities {
  modelId: string
  mode: AudioMode
  family: string
  task: AudioTask
  params: AudioModelParam[]
  /** Built-in voices the model lists (`voice_id` values), empty when it has none. */
  voices: string[]
  /** Speech only: the model clones a voice from reference audio (`voiceRef`). */
  supportsVoiceRef: boolean
  /** Speech only: the model speaks only in a cloned voice, so a job without `voiceRef` is refused. */
  requiresVoiceRef: boolean
}

/** A WAV to read on the core's computer, or WAV bytes. */
export type AudioSource = { path: string } | { base64: string }

export interface AudioGenerateRequest {
  /** Speech: the words to say. Music and effects: the description of the sound. */
  text: string
  /** Speech: a built-in voice id; absent for the model's default. */
  voice?: string
  /** Speech: a voice to clone, for models that take one. */
  voiceRef?: AudioSource
  /** Speech: the transcript of `voiceRef`. */
  referenceText?: string
  /** Speech: rate multiplier, where the model declares support. */
  speed?: number
  language?: string
  /** Speech: a style instruction, where the model takes one. */
  instruct?: string
  /** Music: the words to sing. */
  lyrics?: string
  /** Music and effects: target length in seconds. */
  durationSec?: number
  /** Music: beats per minute. */
  bpm?: number
  /** Absent or negative: the core draws one; the recipe records the seed used. */
  seed?: number
  /** Diffusion steps, for the families that take them. */
  steps?: number
  negativePrompt?: string
  /** Any other request option the model declares; the named fields above win over the same key here. */
  options?: AudioOptions
}

/** `POST /atomic/v1/audio/jobs`: what to make, in which mode. */
export interface AudioJobSubmission {
  mode: AudioMode
  request: AudioGenerateRequest
}

export interface AudioJobProgress {
  phase: AudioJobPhase
  elapsedMs: number
}

export interface AudioJob {
  id: string
  state: AudioJobState
  mode: AudioMode
  modelId: string
  /** The request with inline audio bytes blanked; file paths stay. */
  request: AudioGenerateRequest
  createdAtMs: number
  startedAtMs?: number
  finishedAtMs?: number
  progress: AudioJobProgress | null
  output: AudioGalleryItem | null
  error?: AudioErrorBody
}

/** Written next to every clip as `<jobId>.json`. Enough to reproduce it. */
export interface AudioRecipe {
  jobId: string
  mode: AudioMode
  text: string
  voice: string | null
  /** True when a reference voice was cloned; its bytes are not kept. */
  voiceRef: boolean
  speed: number | null
  language: string | null
  instruct: string | null
  lyrics: string | null
  durationSec: number | null
  bpm: number | null
  seed: number
  steps: number | null
  negativePrompt: string | null
  options: AudioOptions
  model: {
    modelId: string
    family: string
    task: AudioTask
    displayName: string
    /** Basename of the model file. */
    filename: string
  }
  engine: { kind: 'audio-cpp'; backend: AudioBackend; tag: string }
  createdAtMs: number
  /** Wall time of the request to the engine. */
  durationMs: number
}

export interface AudioGalleryItem {
  /** The job id; also the file stem (`<jobId>.wav`, `<jobId>.json`). */
  id: string
  path: string
  sampleRate: number
  channels: number
  /** Length of the clip. */
  audioMs: number
  sizeBytes: number
  createdAtMs: number
  recipe: AudioRecipe
}

export interface AudioGalleryPage {
  items: AudioGalleryItem[]
  hasMore: boolean
  total: number
}

export interface AudioGalleryListOptions {
  offset: number
  limit: number
}

/** A file found under `<data>/audio/models`. */
export interface AudioModelFile {
  path: string
  /** Relative to the models root, `/`-separated. */
  relativePath: string
  bytes: number
}

export interface AudioCancelResult {
  cancelled: boolean
  /** True when the server had to be stopped to interrupt the generation (always, today). */
  serverStopped: boolean
}

/** The relayed `audio:{state,job,error}` events, plus the relay's snapshot. */
export type AudioEvent =
  | { type: 'state'; status: AudioStatus; reason?: string }
  | { type: 'job'; job: AudioJob }
  | {
      type: 'error'
      jobId?: string
      code: AudioErrorCode
      message: string
      details?: string
    }
  /** A core generation attached: a new one knows no jobs and has to be asked again. */
  | { type: 'reset' }

/** Every method maps onto one core control route (`TauriAudioService` names them). */
export interface AudioService {
  /** True on desktop builds, where a core can answer at all. */
  isSupported(): boolean

  getStatus(): Promise<AudioStatus>
  configure(config: AudioConfig): Promise<AudioStatus>
  /** An empty path restores `<data>/audios`. */
  setOutputDir(path: string): Promise<AudioStatus>

  listModelFiles(): Promise<AudioModelFile[]>
  /** A file named relative to `<data>/audio/models`. */
  deleteModelFile(relativePath: string): Promise<void>

  /** Answers once the server serves the model. */
  loadModel(request: LoadAudioModelRequest): Promise<LoadedAudioModel>
  unloadModel(): Promise<void>
  touchIdle(): Promise<void>
  getCapabilities(): Promise<AudioCapabilities>

  /** Answers the job at once; its phases and outcome arrive as `job` events. */
  generate(mode: AudioMode, request: AudioGenerateRequest): Promise<AudioJob>
  getJob(jobId: string): Promise<AudioJob | null>
  cancelJob(jobId: string): Promise<AudioCancelResult>

  listGallery(options: AudioGalleryListOptions): Promise<AudioGalleryPage>
  deleteGalleryItem(id: string): Promise<void>

  /** audio.cpp's builds, through `/engine-builds/audio-cpp/*`. */
  engineCatalog(
    request?: EngineBuildCatalogRequest
  ): Promise<EngineBuildCatalog>
  checkEngineUpdate(
    request?: EngineBuildUpdateCheckRequest
  ): Promise<EngineBuildUpdateCheck>
  installEngine(
    request: EngineBuildInstallRequest
  ): Promise<EngineBuildInstallResult>
  removeEngineBuild(
    tag: string,
    backendId: string
  ): Promise<EngineBuildRemoveResult>

  /** Returns the unsubscribe. */
  subscribe(handler: (event: AudioEvent) => void): () => void
}
