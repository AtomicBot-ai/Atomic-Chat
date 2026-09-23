/**
 * Shared fixtures for the Video tests: the two video families of the catalog
 * (LTX-2.3 distilled and Wan 2.2 TI2V 5B, with small byte counts), the
 * capabilities the core answers for them, and video jobs and gallery items.
 *
 * Not a test file (no `.test.` suffix); Vitest only picks up the specs that
 * import it.
 */
import type {
  GalleryVideoItem,
  VideoCapabilities,
  VideoGenerateRequest,
  VideoJob,
  VideoRecipe,
} from '@/services/diffusion/types'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'

export const LTX_2: DiffusionCatalogFamily = {
  id: 'ltx-2',
  name: 'LTX-2.3 Distilled',
  developer: 'Lightricks',
  description: 'Text-to-video with synchronised audio.',
  modality: 'video',
  engines: ['sdcpp'],
  transformer: {
    repo: 'unsloth/LTX-2.3-GGUF',
    quants: [
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'distilled/ltx-2.3-22b-distilled-Q4_K_M.gguf',
        bytes: 14_000_000_000,
        recommended: true,
      },
      {
        id: 'q8_0',
        label: 'Q8_0',
        filename: 'distilled/ltx-2.3-22b-distilled-Q8_0.gguf',
        bytes: 22_000_000_000,
      },
    ],
  },
  vae: {
    repo: 'unsloth/LTX-2.3-GGUF',
    filename: 'vae/ltx-2.3-22b-distilled_video_vae.safetensors',
    bytes: 1_400_000_000,
  },
  audio_vae: {
    repo: 'unsloth/LTX-2.3-GGUF',
    filename: 'vae/ltx-2.3-22b-distilled_audio_vae.safetensors',
    bytes: 360_000_000,
  },
  text_encoders: [
    {
      repo: 'unsloth/gemma-3-12b-it-qat-GGUF',
      filename: 'gemma-3-12b-it-qat-UD-Q4_K_XL.gguf',
      bytes: 7_400_000_000,
      field: 'llm',
    },
    {
      repo: 'unsloth/LTX-2.3-GGUF',
      filename:
        'text_encoders/ltx-2.3-22b-distilled_embeddings_connectors.safetensors',
      bytes: 2_300_000_000,
      field: 'embeddings_connectors',
    },
  ],
  defaults: {
    steps: 8,
    cfg_scale: 1,
    sampling_method: 'euler',
    width: 768,
    height: 512,
    sigmas: [1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875],
  },
  ranges: { steps: [1, 50], dims: [256, 1216], dim_multiple: 32 },
  video: {
    fps: 24,
    frame_step: 8,
    frame_offset: 1,
    frames: 121,
    frame_range: [9, 257],
    resolution_presets: [
      [768, 512],
      [1216, 704],
      [704, 1216],
      [512, 768],
    ],
  },
  capabilities: {
    negative_prompt: false,
    guidance: false,
    workflows: ['create'],
  },
}

export const WAN_22: DiffusionCatalogFamily = {
  id: 'wan2.2-ti2v-5b',
  name: 'Wan 2.2 TI2V 5B',
  developer: 'Wan-AI',
  modality: 'video',
  engines: ['sdcpp'],
  transformer: {
    repo: 'unsloth/Wan2.2-TI2V-5B-GGUF',
    quants: [
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'Wan2.2-TI2V-5B-Q4_K_M.gguf',
        bytes: 3_400_000_000,
        recommended: true,
      },
    ],
  },
  vae: {
    repo: 'unsloth/Wan2.2-TI2V-5B-GGUF',
    filename: 'VAE/Wan2.2_VAE.safetensors',
    bytes: 1_400_000_000,
  },
  text_encoders: [
    {
      repo: 'city96/umt5-xxl-encoder-gguf',
      filename: 'umt5-xxl-encoder-Q4_K_M.gguf',
      bytes: 3_600_000_000,
      field: 't5xxl',
    },
  ],
  defaults: {
    steps: 30,
    cfg_scale: 5,
    sampling_method: 'euler',
    flow_shift: 5,
    width: 1280,
    height: 704,
  },
  ranges: { steps: [1, 100], dims: [256, 1280], dim_multiple: 16 },
  video: {
    fps: 24,
    frame_step: 4,
    frame_offset: 1,
    frames: 121,
    frame_range: [5, 241],
    resolution_presets: [
      [1280, 704],
      [704, 1280],
    ],
  },
  capabilities: {
    negative_prompt: true,
    guidance: false,
    workflows: ['create'],
  },
}

export const LTX_Q4_ID = 'ltx-2:q4_k_m'
export const WAN_Q4_ID = 'wan2.2-ti2v-5b:q4_k_m'

export function makeVideoCapabilities(
  overrides: Partial<VideoCapabilities> = {}
): VideoCapabilities {
  return {
    workflows: ['create'],
    minDim: 256,
    maxDim: 1216,
    dimMultiple: 32,
    supportsNegativePrompt: false,
    supportsGuidance: false,
    cancelGenerating: false,
    fps: 24,
    frames: { min: 9, max: 257, step: 8, offset: 1, default: 121 },
    resolutionPresets: [
      [768, 512],
      [1216, 704],
      [704, 1216],
      [512, 768],
    ],
    outputFormat: 'webm',
    webmSupported: true,
    defaults: {
      steps: 8,
      cfgScale: 1,
      samplingMethod: 'euler',
      width: 768,
      height: 512,
      video: {
        fps: 24,
        frames: 121,
        frameStep: 8,
        frameOffset: 1,
        resolutionPresets: [
          [768, 512],
          [1216, 704],
          [704, 1216],
          [512, 768],
        ],
      },
    },
    ranges: {
      steps: [1, 50],
      dims: [256, 1216],
      dimMultiple: 32,
      frames: [9, 257],
    },
    ...overrides,
  }
}

/** Wan's capabilities: a negative prompt and cfg apply, the lattice is 4k+1. */
export function makeWanCapabilities(
  overrides: Partial<VideoCapabilities> = {}
): VideoCapabilities {
  return makeVideoCapabilities({
    minDim: 256,
    maxDim: 1280,
    dimMultiple: 16,
    supportsNegativePrompt: true,
    frames: { min: 5, max: 241, step: 4, offset: 1, default: 121 },
    resolutionPresets: [
      [1280, 704],
      [704, 1280],
    ],
    defaults: {
      steps: 30,
      cfgScale: 5,
      samplingMethod: 'euler',
      flowShift: 5,
      width: 1280,
      height: 704,
      video: {
        fps: 24,
        frames: 121,
        frameStep: 4,
        frameOffset: 1,
        resolutionPresets: [
          [1280, 704],
          [704, 1280],
        ],
      },
    },
    ranges: {
      steps: [1, 100],
      dims: [256, 1280],
      dimMultiple: 16,
      frames: [5, 241],
    },
    ...overrides,
  })
}

export function makeVideoRequest(
  overrides: Partial<VideoGenerateRequest> = {}
): VideoGenerateRequest {
  return {
    prompt: 'a lighthouse at dusk, waves rolling in',
    width: 768,
    height: 512,
    frames: 49,
    fps: 24,
    steps: 8,
    cfgScale: 1,
    samplingMethod: 'euler',
    ...overrides,
  }
}

export function makeVideoRecipe(
  overrides: Partial<VideoRecipe> = {}
): VideoRecipe {
  return {
    jobId: 'vjob-1',
    prompt: 'a lighthouse at dusk, waves rolling in',
    negativePrompt: null,
    width: 768,
    height: 512,
    frames: 49,
    frameCount: 49,
    fps: 24,
    steps: 8,
    cfgScale: 1,
    guidance: null,
    seed: 42,
    samplingMethod: 'euler',
    flowShift: null,
    workflow: 'create',
    outputFormat: 'webm',
    model: {
      modelId: LTX_Q4_ID,
      family: 'ltx-2',
      displayName: 'LTX-2.3 Distilled Q4_K_M',
      filename: 'ltx-2.3-22b-distilled-Q4_K_M.gguf',
    },
    engine: {
      kind: 'sd-cpp',
      backend: 'metal',
      tag: 'master-883-137f740',
      offload: 'group',
      cpuFallback: false,
    },
    createdAtMs: new Date(2026, 8, 23, 14, 30, 5).getTime(),
    durationMs: 65_000,
    ...overrides,
  }
}

export function makeVideoItem(
  overrides: Partial<GalleryVideoItem> = {}
): GalleryVideoItem {
  const id = overrides.id ?? 'vjob-1'
  return {
    id,
    path: `/data/videos/${id}.webm`,
    posterPath: `/data/videos/${id}.thumb.png`,
    width: 768,
    height: 512,
    fps: 24,
    frameCount: 49,
    durationSecs: 49 / 24,
    sizeBytes: 2_400_000,
    createdAtMs: new Date(2026, 8, 23, 14, 30, 5).getTime(),
    pinned: false,
    archived: false,
    recipe: makeVideoRecipe({ jobId: id }),
    ...overrides,
  }
}

export function makeVideoJob(overrides: Partial<VideoJob> = {}): VideoJob {
  return {
    id: 'vjob-1',
    state: 'queued',
    modelId: LTX_Q4_ID,
    request: makeVideoRequest(),
    createdAtMs: 1_000,
    startedAtMs: 1_100,
    finishedAtMs: 66_100,
    progress: null,
    outputs: [],
    ...overrides,
  }
}
