/**
 * Shared fixtures for the Images tests: one catalog family, the on-disk files
 * that make a quant "installed", and a fake `DiffusionService` whose event
 * stream the tests can drive.
 *
 * Not a test file (no `.test.` suffix); Vitest only picks up the specs that
 * import it.
 */
import { vi } from 'vitest'

import { planArtifactDownload } from '@/lib/diffusion/models'
import type {
  DiffusionEvent,
  DiffusionModelFile,
  DiffusionService,
  DiffusionStatus,
  GalleryImageItem,
  ImageCapabilities,
  ImageGenerateRequest,
  ImageJob,
  ImageRecipe,
} from '@/services/diffusion/types'
import type {
  DiffusionCatalog,
  DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'

export const MODELS_ROOT = '/data/diffusion/models'

export const Z_IMAGE: DiffusionCatalogFamily = {
  id: 'z-image',
  name: 'Z-Image Turbo',
  developer: 'Tongyi-MAI',
  description: 'Fast distilled model.',
  modality: 'image',
  engines: ['sdcpp'],
  transformer: {
    repo: 'leejet/Z-Image-Turbo-GGUF',
    quants: [
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'z-image-turbo-Q4_K_M.gguf',
        bytes: 4_000_000_000,
        recommended: true,
      },
      {
        id: 'q8_0',
        label: 'Q8_0',
        filename: 'z-image-turbo-Q8_0.gguf',
        bytes: 8_000_000_000,
      },
    ],
  },
  vae: {
    repo: 'Tongyi-MAI/Z-Image-Turbo',
    filename: 'vae/ae.safetensors',
    bytes: 300_000_000,
  },
  text_encoders: [
    {
      repo: 'unsloth/Qwen3-4B-GGUF',
      filename: 'Qwen3-4B-Q4_K_M.gguf',
      bytes: 2_500_000_000,
      field: 'llm',
    },
  ],
  defaults: {
    steps: 8,
    cfg_scale: 1,
    width: 1024,
    height: 1024,
  },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
  capabilities: {
    negative_prompt: false,
    guidance: false,
    workflows: ['create'],
  },
}

export const Q4_ID = 'z-image:q4_k_m'
export const Q8_ID = 'z-image:q8_0'

export function makeCatalog(
  families: DiffusionCatalogFamily[] = [Z_IMAGE]
): DiffusionCatalog {
  return { schema_version: 1, updated_at: '2026-09-01', families }
}

/** The files that make `quantId` of `family` complete, as the plugin lists them. */
export function makeFilesFor(
  family: DiffusionCatalogFamily,
  quantId: string
): DiffusionModelFile[] {
  return planArtifactDownload(family, quantId, [], MODELS_ROOT).entries.map(
    (entry) => ({
      path: entry.savePath,
      relativePath: entry.relativePath,
      bytes: entry.bytes,
    })
  )
}

export function makeCapabilities(
  overrides: Partial<ImageCapabilities> = {}
): ImageCapabilities {
  return {
    workflows: ['create'],
    minDim: 256,
    maxDim: 2048,
    dimMultiple: 16,
    supportsNegativePrompt: false,
    supportsGuidance: false,
    cancelGenerating: false,
    maxBatch: 4,
    defaults: { steps: 8, cfgScale: 1, width: 1024, height: 1024 },
    ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
    ...overrides,
  }
}

export function makeStatus(
  overrides: Partial<DiffusionStatus> = {}
): DiffusionStatus {
  return {
    configured: true,
    install: {
      state: 'installed',
      engine: 'sd-cpp',
      backend: 'metal',
      tag: 'master-849-d04e895',
      backendId: 'macos-arm64',
      dir: '/data/diffusion/backends/master-849-d04e895/macos-arm64',
    },
    model: { state: 'unloaded', loaded: null },
    activeJob: null,
    outputDir: '/data/images',
    idleUnloadSecs: 600,
    ...overrides,
  }
}

export function makeLoadedStatus(modelId = Q4_ID): DiffusionStatus {
  return makeStatus({
    model: {
      state: 'loaded',
      loaded: {
        modelId,
        family: 'z-image',
        modality: 'image',
        displayName: 'Z-Image Turbo Q4_K_M',
        engine: 'sd-cpp',
        backend: 'metal',
        offload: 'none',
        cpuFallback: false,
        port: 43111,
        pid: 4242,
        loadedAtMs: 1_000,
      },
    },
  })
}

export function makeRequest(
  overrides: Partial<ImageGenerateRequest> = {}
): ImageGenerateRequest {
  return {
    prompt: 'a lighthouse at dusk',
    width: 1024,
    height: 1024,
    steps: 8,
    cfgScale: 1,
    batchSize: 1,
    ...overrides,
  }
}

export function makeRecipe(overrides: Partial<ImageRecipe> = {}): ImageRecipe {
  return {
    jobId: 'job-1',
    index: 0,
    prompt: 'a lighthouse at dusk',
    negativePrompt: null,
    width: 1024,
    height: 768,
    steps: 8,
    cfgScale: 1,
    guidance: null,
    seed: 43,
    batchSeed: 42,
    batchSize: 2,
    samplingMethod: 'euler',
    flowShift: null,
    workflow: 'create',
    strength: null,
    model: {
      modelId: Q4_ID,
      family: 'z-image',
      displayName: 'Z-Image Turbo Q4_K_M',
      filename: 'z-image-turbo-Q4_K_M.gguf',
    },
    engine: {
      kind: 'sd-cpp',
      backend: 'metal',
      tag: 'master-849-d04e895',
      offload: 'none',
      cpuFallback: false,
    },
    createdAtMs: new Date(2026, 8, 10, 14, 30, 5).getTime(),
    durationMs: 12_300,
    ...overrides,
  }
}

export function makeItem(
  overrides: Partial<GalleryImageItem> = {}
): GalleryImageItem {
  const id = overrides.id ?? 'job-1-00'
  return {
    id,
    path: `/data/images/${id}.png`,
    thumbnailPath: `/data/images/${id}.thumb.webp`,
    width: 1024,
    height: 768,
    sizeBytes: 1_200_000,
    createdAtMs: new Date(2026, 8, 10, 14, 30, 5).getTime(),
    pinned: false,
    archived: false,
    recipe: makeRecipe({ jobId: id.replace(/-\d\d$/, '') }),
    ...overrides,
  }
}

export function makeJob(overrides: Partial<ImageJob> = {}): ImageJob {
  return {
    id: 'job-1',
    state: 'queued',
    modelId: Q4_ID,
    request: makeRequest(),
    createdAtMs: 1_000,
    startedAtMs: 1_100,
    finishedAtMs: 13_400,
    progress: null,
    outputs: [],
    ...overrides,
  }
}

type Mocked<T> = {
  [K in keyof T]: T[K] extends (...args: infer A) => infer R
    ? ReturnType<typeof vi.fn<(...args: A) => R>>
    : T[K]
}

export type FakeDiffusion = Mocked<DiffusionService> & {
  /** Push an event to every subscriber, the way the plugin would. */
  emit: (event: DiffusionEvent) => void
  /** Pending gallery listing, mutable per test. */
  gallery: GalleryImageItem[]
}

/**
 * A `DiffusionService` whose every method is a `vi.fn` with a sensible
 * default, plus `emit` to drive the event stream.
 */
export function makeFakeDiffusion(
  overrides: Partial<Mocked<DiffusionService>> = {}
): FakeDiffusion {
  const handlers = new Set<(event: DiffusionEvent) => void>()
  let status = makeStatus()
  const fake: FakeDiffusion = {
    gallery: [],
    emit: (event) => {
      if (event.type === 'state') status = event.status
      handlers.forEach((handler) => handler(event))
    },
    isSupported: vi.fn(() => true),
    configure: vi.fn(async () => status),
    getStatus: vi.fn(async () => status),
    finalizeBackendInstall: vi.fn(),
    listInstalledBackends: vi.fn(async () => []),
    removeBackend: vi.fn(async () => undefined),
    listModelFiles: vi.fn(async () => [] as DiffusionModelFile[]),
    deleteModelFile: vi.fn(async () => undefined),
    loadModel: vi.fn(async (request) => {
      status = makeLoadedStatus(request.modelId)
      return status.model.loaded!
    }),
    unloadModel: vi.fn(async () => {
      status = makeStatus({ install: status.install })
    }),
    getCapabilities: vi.fn(async () => makeCapabilities()),
    touchIdle: vi.fn(async () => undefined),
    generate: vi.fn(async () => ({ jobId: 'job-1' })),
    getJob: vi.fn(async () => null),
    cancelJob: vi.fn(async () => ({ cancelled: true, serverStopped: true })),
    listGallery: vi.fn(async ({ offset, limit }) => ({
      items: fake.gallery.slice(offset, offset + limit),
      hasMore: offset + limit < fake.gallery.length,
      total: fake.gallery.length,
    })),
    getGalleryItem: vi.fn(async (id) => fake.gallery.find((i) => i.id === id) ?? null),
    deleteGalleryItems: vi.fn(async (ids) => {
      fake.gallery = fake.gallery.filter((item) => !ids.includes(item.id))
    }),
    setGalleryFlags: vi.fn(),
    exportGalleryItem: vi.fn(async () => undefined),
    setOutputDir: vi.fn(async (path) => {
      status = { ...status, outputDir: path }
      return status
    }),
    subscribe: vi.fn((handler) => {
      handlers.add(handler)
      return () => handlers.delete(handler)
    }),
    ...overrides,
  } as FakeDiffusion
  return fake
}
