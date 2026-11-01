import { vi } from 'vitest'

import { getBaselineAudioCatalog } from '@/services/audio-catalog-registry'
import { DefaultAudioService } from '@/services/audio/default'
import type {
  AudioEvent,
  AudioGalleryItem,
  AudioJob,
  AudioMode,
  AudioModelFile,
  AudioStatus,
  LoadedAudioModel,
} from '@/services/audio/types'
import type { EngineBuildCatalog } from '@/services/engine-builds/types'

export const QWEN = 'qwen3-tts-1.7b-customvoice'
export const QWEN_WIRE = `${QWEN}:q8_0`
export const MOSS = 'moss-tts-nano-100m'
export const ACE = 'ace-step-1.5-turbo'
export const SFX = 'stable-audio-3-small-sfx'
export const SFX_WIRE = `${SFX}:q8_0`

export const catalog = () => getBaselineAudioCatalog()

/** What the core answers for a route it does not have (`server/control/server.ts`). */
export const missingRoute = (path = '/atomic/v1/audio/status') => ({
  code: 'INVALID_ARGUMENT',
  message: `No such control route: ${path}`,
})

export const makeLoaded = (
  overrides: Partial<LoadedAudioModel> = {}
): LoadedAudioModel => ({
  modelId: QWEN_WIRE,
  displayName: 'Qwen3-TTS 1.7B',
  mode: 'speech',
  family: 'qwen3_tts',
  task: 'tts',
  backend: 'metal',
  tag: 'v0.9.3',
  backendId: 'macos-arm64',
  port: 18000,
  pid: 42,
  loadedAtMs: 1,
  ...overrides,
})

export const makeStatus = (
  overrides: Partial<AudioStatus> = {}
): AudioStatus => ({
  install: {
    state: 'installed',
    backend: 'metal',
    tag: 'v0.9.3',
    backendId: 'macos-arm64',
    dir: '/data/audio/backends/v0.9.3/macos-arm64',
  },
  model: { state: 'unloaded', loaded: null },
  activeJob: null,
  outputDir: '/data/audios',
  idleUnloadSecs: 600,
  ...overrides,
})

export const makeLoadedStatus = (
  loaded: LoadedAudioModel = makeLoaded()
): AudioStatus => makeStatus({ model: { state: 'loaded', loaded } })

export const makeFile = (
  modelId: string,
  catalogFile = catalog()
): AudioModelFile => {
  const quant = catalogFile.models.find((model) => model.id === modelId)
    ?.quants[0]
  if (!quant) throw new Error(`No model ${modelId}`)
  return {
    path: `/data/audio/models/${quant.filename}`,
    relativePath: quant.filename,
    bytes: quant.bytes,
  }
}

export const makeItem = (
  id = 'job-1',
  overrides: {
    mode?: AudioMode
    modelId?: string
    text?: string
    sampleRate?: number
    channels?: number
  } = {}
): AudioGalleryItem => {
  const {
    mode = 'speech',
    modelId = QWEN_WIRE,
    text = 'Hello there',
    sampleRate = 24000,
    channels = 1,
  } = overrides
  return {
    id,
    path: `/data/audios/${id}.wav`,
    sampleRate,
    channels,
    audioMs: 2500,
    sizeBytes: 120_000,
    createdAtMs: 1000,
    recipe: {
      jobId: id,
      mode,
      text,
      voice: null,
      voiceRef: false,
      speed: null,
      language: null,
      instruct: null,
      lyrics: null,
      durationSec: null,
      bpm: null,
      seed: 42,
      steps: null,
      negativePrompt: null,
      options: {},
      model: {
        modelId,
        family: 'qwen3_tts',
        task: 'tts',
        displayName: 'Qwen3-TTS 1.7B',
        filename: 'model.gguf',
      },
      engine: { kind: 'audio-cpp', backend: 'metal', tag: 'v0.9.3' },
      createdAtMs: 1000,
      durationMs: 900,
    },
  }
}

export const makeJob = (overrides: Partial<AudioJob> = {}): AudioJob => ({
  id: 'job-1',
  state: 'queued',
  mode: 'speech',
  modelId: QWEN_WIRE,
  request: { text: 'Hello there' },
  createdAtMs: 1000,
  progress: { phase: 'queued', elapsedMs: 0 },
  output: null,
  ...overrides,
})

export const makeEngineCatalog = (
  overrides: Partial<EngineBuildCatalog> = {}
): EngineBuildCatalog => ({
  engine: 'audio-cpp',
  manifest: {
    tag: 'v0.9.3',
    source: 'remote',
    fetched_at: 1,
    error: null,
  },
  manifest_error: null,
  host_backend_id: 'macos-arm64',
  host_reason: null,
  host_download_bytes: 60_000_000,
  installed: [],
  active: null,
  ...overrides,
})

/** The service with every route the tests touch as a mock, and a way to raise events. */
export function makeFakeAudio() {
  const handlers = new Set<(event: AudioEvent) => void>()
  const fake = new DefaultAudioService()
  const mocks = {
    getStatus: vi.fn(async () => makeStatus()),
    listModelFiles: vi.fn(async (): Promise<AudioModelFile[]> => []),
    deleteModelFile: vi.fn(async () => {}),
    loadModel: vi.fn(async () => makeLoaded()),
    unloadModel: vi.fn(async () => {}),
    getCapabilities: vi.fn(async () => ({
      modelId: QWEN_WIRE,
      mode: 'speech' as const,
      family: 'qwen3_tts',
      task: 'tts' as const,
      params: [],
      voices: ['vivian', 'uncle_fu'],
      supportsVoiceRef: false,
      requiresVoiceRef: false,
    })),
    generate: vi.fn(async () => makeJob()),
    getJob: vi.fn(async (): Promise<AudioJob | null> => makeJob()),
    cancelJob: vi.fn(async () => ({ cancelled: true, serverStopped: true })),
    listGallery: vi.fn(async () => ({
      items: [] as AudioGalleryItem[],
      hasMore: false,
      total: 0,
    })),
    deleteGalleryItem: vi.fn(async () => {}),
    engineCatalog: vi.fn(async () => makeEngineCatalog()),
    installEngine: vi.fn(async () => ({
      installed: true,
      build: {
        tag: 'v0.9.3',
        backend_id: 'macos-arm64',
        origin: 'downloaded' as const,
      },
      retired: [],
      kept_in_use: [],
    })),
  }
  Object.assign(fake, mocks, {
    isSupported: () => true,
    subscribe: (handler: (event: AudioEvent) => void) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    },
  })
  return Object.assign(fake, mocks, {
    emit: (event: AudioEvent) => handlers.forEach((handler) => handler(event)),
  })
}

export type FakeAudio = ReturnType<typeof makeFakeAudio>
