import { beforeEach, describe, expect, it, vi } from 'vitest'

import { seedServiceHub } from '@/test/service-hub'
import type {
  DiffusionCatalog,
  DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'
import type {
  DiffusionModelFile,
  DiffusionService,
} from '@/services/diffusion/types'

import type { AppService } from '@/services/app/types'

import {
  artifactId,
  buildLoadRequest,
  cancelArtifactDownload,
  deleteArtifact,
  diffusionDownloadTaskId,
  downloadArtifact,
  listInstalledArtifacts,
  parseArtifactId,
  planArtifactDeletion,
  planArtifactDownload,
  sharedRepoDir,
} from '../models'

const QWEN3 = {
  repo: 'unsloth/Z-Image-Turbo-ComfyUI',
  filename: 'split_files/text_encoders/qwen_3_4b.safetensors',
  bytes: 8_044_982_048,
  sha256: 'a'.repeat(64),
  field: 'llm' as const,
}

const AE = {
  repo: 'unsloth/Z-Image-Turbo-ComfyUI',
  filename: 'split_files/vae/ae.safetensors',
  bytes: 335_304_388,
}

const zImage: DiffusionCatalogFamily = {
  id: 'z-image',
  name: 'Z-Image Turbo',
  modality: 'image',
  engines: ['sdcpp'],
  transformer: {
    repo: 'unsloth/Z-Image-Turbo-GGUF',
    quants: [
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'z-image-turbo-Q4_K_M.gguf',
        bytes: 5_017_613_376,
        sha256: 'b'.repeat(64),
      },
      {
        id: 'q8_0',
        label: 'Q8_0',
        filename: 'z-image-turbo-Q8_0.gguf',
        bytes: 7_224_707_136,
      },
    ],
  },
  vae: AE,
  text_encoders: [QWEN3],
  defaults: { steps: 8, cfg_scale: 1, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
  capabilities: { negative_prompt: false, guidance: false, workflows: ['create'] },
}

const klein: DiffusionCatalogFamily = {
  id: 'flux.2-klein',
  name: 'FLUX.2 Klein 4B',
  modality: 'image',
  engines: ['sdcpp'],
  transformer: {
    repo: 'unsloth/FLUX.2-klein-4B-GGUF',
    quants: [
      {
        id: 'q4_k_m',
        label: 'Q4_K_M',
        filename: 'flux-2-klein-4b-Q4_K_M.gguf',
        bytes: 2_604_311_104,
      },
    ],
  },
  vae: {
    repo: 'unsloth/FLUX.2-VAE',
    filename: 'split_files/vae/flux2-vae.safetensors',
    bytes: 336_213_556,
  },
  vae_format: 'flux2',
  text_encoders: [QWEN3],
  defaults: { steps: 4, cfg_scale: 1, sampling_method: 'euler', flow_shift: 3, width: 1024, height: 1024 },
  ranges: { steps: [1, 50], dims: [256, 2048], dim_multiple: 16 },
  capabilities: { negative_prompt: false, guidance: true, workflows: ['create', 'transform'] },
}

const catalog: DiffusionCatalog = {
  schema_version: 1,
  updated_at: '2026-09-10T00:00:00Z',
  families: [zImage, klein],
}

const ROOT = '/data/diffusion/models'

const onDisk = (relativePath: string, bytes: number): DiffusionModelFile => ({
  path: `${ROOT}/${relativePath}`,
  relativePath,
  bytes,
})

const SHARED_TE = 'shared/unsloth--Z-Image-Turbo-ComfyUI/qwen_3_4b.safetensors'
const SHARED_AE = 'shared/unsloth--Z-Image-Turbo-ComfyUI/ae.safetensors'
const SHARED_FLUX2_VAE = 'shared/unsloth--FLUX.2-VAE/flux2-vae.safetensors'

describe('artifact ids', () => {
  it('round-trips family and quant', () => {
    expect(artifactId('flux.2-klein', 'q4_k_m')).toBe('flux.2-klein:q4_k_m')
    expect(parseArtifactId('flux.2-klein:q4_k_m')).toEqual({
      family: 'flux.2-klein',
      quantId: 'q4_k_m',
    })
  })

  it('rejects ids that are not a known family plus a quant', () => {
    expect(parseArtifactId('sdxl:q4')).toBeNull()
    expect(parseArtifactId('z-image')).toBeNull()
    expect(parseArtifactId('z-image:')).toBeNull()
  })

  it('makes a download task id Tauri accepts as an event name', () => {
    const taskId = diffusionDownloadTaskId('flux.1:q4_k_m')
    expect(taskId).toBe('diffusion-model-flux_1_q4_k_m')
    expect(taskId).toMatch(/^[A-Za-z0-9_-]+$/)
  })

  it('flattens a repo id into one shared folder name', () => {
    expect(sharedRepoDir('unsloth/FLUX.2-VAE')).toBe('unsloth--FLUX.2-VAE')
  })
})

describe('planArtifactDownload', () => {
  it('puts the transformer under the family and side files under shared/', () => {
    const plan = planArtifactDownload(zImage, 'q4_k_m', [], ROOT)
    expect(plan.artifactId).toBe('z-image:q4_k_m')
    expect(plan.entries.map((e) => [e.kind, e.savePath])).toEqual([
      ['transformer', `${ROOT}/z-image/z-image-turbo-Q4_K_M.gguf`],
      ['vae', `${ROOT}/${SHARED_AE}`],
      ['text_encoder', `${ROOT}/${SHARED_TE}`],
    ])
    expect(plan.entries[0]).toMatchObject({
      url: 'https://huggingface.co/unsloth/Z-Image-Turbo-GGUF/resolve/main/z-image-turbo-Q4_K_M.gguf',
      sha256: 'b'.repeat(64),
      bytes: 5_017_613_376,
      present: false,
    })
    expect(plan.entries[2]).toMatchObject({
      url: 'https://huggingface.co/unsloth/Z-Image-Turbo-ComfyUI/resolve/main/split_files/text_encoders/qwen_3_4b.safetensors',
      field: 'llm',
    })
    expect(plan.totalBytes).toBe(5_017_613_376 + 335_304_388 + 8_044_982_048)
    expect(plan.missingBytes).toBe(plan.totalBytes)
  })

  it('lands the shared text encoder on the same path for both families', () => {
    const forZ = planArtifactDownload(zImage, 'q4_k_m', [], ROOT)
    const forKlein = planArtifactDownload(klein, 'q4_k_m', [], ROOT)
    const te = (plan: typeof forZ) =>
      plan.entries.find((e) => e.kind === 'text_encoder')!.savePath
    expect(te(forZ)).toBe(te(forKlein))
  })

  it('marks a file present only when the bytes match', () => {
    const files = [
      onDisk(SHARED_TE, QWEN3.bytes),
      onDisk('z-image/z-image-turbo-Q4_K_M.gguf', 12), // truncated download
    ]
    const plan = planArtifactDownload(zImage, 'q4_k_m', files, ROOT)
    expect(plan.entries.map((e) => [e.kind, e.present])).toEqual([
      ['transformer', false],
      ['vae', false],
      ['text_encoder', true],
    ])
    expect(plan.missingBytes).toBe(5_017_613_376 + 335_304_388)
  })

  it('accepts Windows-style relative paths from the plugin', () => {
    const files = [
      {
        path: 'C:\\data\\diffusion\\models\\z-image\\z-image-turbo-Q8_0.gguf',
        relativePath: 'z-image\\z-image-turbo-Q8_0.gguf',
        bytes: 7_224_707_136,
      },
    ]
    const plan = planArtifactDownload(zImage, 'q8_0', files, 'C:\\data\\diffusion\\models')
    expect(plan.entries[0].present).toBe(true)
    expect(plan.entries[0].savePath).toBe(
      'C:\\data\\diffusion\\models\\z-image\\z-image-turbo-Q8_0.gguf'
    )
  })

  it('refuses a quant the family does not list', () => {
    expect(() => planArtifactDownload(zImage, 'q2_k', [], ROOT)).toThrow(
      'Family z-image has no quant "q2_k"'
    )
  })
})

describe('listInstalledArtifacts', () => {
  it('reports artifacts whose transformer is on disk, with what they still lack', () => {
    const files = [
      onDisk('z-image/z-image-turbo-Q4_K_M.gguf', 5_017_613_376),
      onDisk('flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf', 2_604_311_104),
      onDisk(SHARED_TE, QWEN3.bytes),
      onDisk(SHARED_FLUX2_VAE, 336_213_556),
    ]
    expect(listInstalledArtifacts(catalog, files)).toEqual([
      {
        id: 'z-image:q4_k_m',
        family: 'z-image',
        quantId: 'q4_k_m',
        bytes: 5_017_613_376 + 335_304_388 + 8_044_982_048,
        complete: false,
        missing: [SHARED_AE],
      },
      {
        id: 'flux.2-klein:q4_k_m',
        family: 'flux.2-klein',
        quantId: 'q4_k_m',
        bytes: 2_604_311_104 + 336_213_556 + 8_044_982_048,
        complete: true,
        missing: [],
      },
    ])
  })

  it('does not count a stray side file as an installed artifact', () => {
    expect(listInstalledArtifacts(catalog, [onDisk(SHARED_TE, QWEN3.bytes)])).toEqual([])
  })
})

describe('planArtifactDeletion', () => {
  const files = [
    onDisk('z-image/z-image-turbo-Q4_K_M.gguf', 5_017_613_376),
    onDisk('flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf', 2_604_311_104),
    onDisk(SHARED_TE, QWEN3.bytes),
    onDisk(SHARED_AE, AE.bytes),
    onDisk(SHARED_FLUX2_VAE, 336_213_556),
  ]

  it('keeps the text encoder Klein still needs, frees the VAE nobody else uses', () => {
    const { remove, kept } = planArtifactDeletion(zImage, 'q4_k_m', files, catalog)
    expect(remove.map((f) => f.relativePath)).toEqual([
      'z-image/z-image-turbo-Q4_K_M.gguf',
      SHARED_AE,
    ])
    expect(kept.map((f) => f.relativePath)).toEqual([SHARED_TE])
  })

  it('frees everything once the last artifact needing the shared file goes', () => {
    const withoutKlein = files.filter(
      (f) => !f.relativePath.startsWith('flux.2-klein/')
    )
    const { remove, kept } = planArtifactDeletion(
      zImage,
      'q4_k_m',
      withoutKlein,
      catalog
    )
    expect(remove.map((f) => f.relativePath)).toEqual([
      'z-image/z-image-turbo-Q4_K_M.gguf',
      SHARED_AE,
      SHARED_TE,
    ])
    expect(kept).toEqual([])
  })

  it('never touches another quant of the same family', () => {
    const twoQuants = [
      ...files,
      onDisk('z-image/z-image-turbo-Q8_0.gguf', 7_224_707_136),
    ]
    const { remove } = planArtifactDeletion(zImage, 'q8_0', twoQuants, catalog)
    expect(remove.map((f) => f.relativePath)).toEqual([
      'z-image/z-image-turbo-Q8_0.gguf',
    ])
  })
})

describe('deleteArtifact', () => {
  let deleted: string[]

  beforeEach(() => {
    deleted = []
    seedServiceHub({
      diffusion: {
        deleteModelFile: vi.fn(async (path: string) => {
          deleted.push(path)
        }),
      } as unknown as DiffusionService,
    })
  })

  it('deletes through the plugin and reports what it kept', async () => {
    const files = [
      onDisk('z-image/z-image-turbo-Q4_K_M.gguf', 5_017_613_376),
      onDisk('flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf', 2_604_311_104),
      onDisk(SHARED_TE, QWEN3.bytes),
    ]
    const result = await deleteArtifact(zImage, 'q4_k_m', files, catalog)
    expect(deleted).toEqual([`${ROOT}/z-image/z-image-turbo-Q4_K_M.gguf`])
    expect(result).toEqual({
      removed: [`${ROOT}/z-image/z-image-turbo-Q4_K_M.gguf`],
      kept: [`${ROOT}/${SHARED_TE}`],
    })
  })
})

describe('buildLoadRequest', () => {
  const files = [
    onDisk('flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf', 2_604_311_104),
    onDisk(SHARED_TE, QWEN3.bytes),
    onDisk(SHARED_FLUX2_VAE, 336_213_556),
  ]

  it('maps catalog fields onto the plugin request', () => {
    const request = buildLoadRequest(klein, 'q4_k_m', files, ROOT, {
      offload: 'group',
      engine: 'sd-cpp',
      threads: 8,
    })
    expect(request).toEqual({
      modelId: 'flux.2-klein:q4_k_m',
      family: 'flux.2-klein',
      modality: 'image',
      displayName: 'FLUX.2 Klein 4B Q4_K_M',
      files: {
        diffusionModel: `${ROOT}/flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf`,
        vae: `${ROOT}/${SHARED_FLUX2_VAE}`,
        vaeFormat: 'flux2',
        llm: `${ROOT}/${SHARED_TE}`,
      },
      defaults: {
        steps: 4,
        cfgScale: 1,
        samplingMethod: 'euler',
        flowShift: 3,
        width: 1024,
        height: 1024,
      },
      ranges: { steps: [1, 50], dims: [256, 2048], dimMultiple: 16 },
      offload: 'group',
      engine: 'sd-cpp',
      threads: 8,
    })
  })

  it('routes each text encoder to its flag slot', () => {
    const flux1: DiffusionCatalogFamily = {
      ...zImage,
      id: 'flux.1',
      name: 'FLUX.1 schnell',
      transformer: {
        repo: 'unsloth/FLUX.1-schnell-GGUF',
        quants: [
          { id: 'q4_k_m', label: 'Q4_K_M', filename: 'flux1-schnell-Q4_K_M.gguf', bytes: 1 },
        ],
      },
      text_encoders: [
        { repo: 'unsloth/flux-text-encoders', filename: 'clip_l.safetensors', bytes: 2, field: 'clip_l' },
        { repo: 'unsloth/flux-text-encoders', filename: 't5xxl_fp16.safetensors', bytes: 3, field: 't5xxl' },
      ],
    }
    const request = buildLoadRequest(flux1, 'q4_k_m', [], ROOT, { offload: 'none' })
    expect(request.files).toEqual({
      diffusionModel: `${ROOT}/flux.1/flux1-schnell-Q4_K_M.gguf`,
      vae: `${ROOT}/${SHARED_AE}`,
      clipL: `${ROOT}/shared/unsloth--flux-text-encoders/clip_l.safetensors`,
      t5xxl: `${ROOT}/shared/unsloth--flux-text-encoders/t5xxl_fp16.safetensors`,
    })
    expect(request.files.vaeFormat).toBeUndefined()
    expect(request.defaults).toEqual({ steps: 8, cfgScale: 1, width: 1024, height: 1024 })
  })

  it('prefers the absolute path the plugin reported over the computed one', () => {
    const reported = [
      {
        path: 'D:\\atomic\\diffusion\\models\\z-image\\z-image-turbo-Q4_K_M.gguf',
        relativePath: 'z-image/z-image-turbo-Q4_K_M.gguf',
        bytes: 5_017_613_376,
      },
    ]
    const request = buildLoadRequest(zImage, 'q4_k_m', reported, 'D:\\atomic\\diffusion\\models', {
      offload: 'none',
    })
    expect(request.files.diffusionModel).toBe(reported[0].path)
  })
})

describe('downloadArtifact', () => {
  const transfers: Array<{ items: unknown[]; taskId: string }> = []
  const cancelled: string[] = []
  let onDiskNow: DiffusionModelFile[]

  beforeEach(() => {
    transfers.length = 0
    cancelled.length = 0
    onDiskNow = [onDisk(SHARED_TE, QWEN3.bytes)]
    const core = (globalThis as unknown as { core: Record<string, unknown> }).core
    core.extensionManager = {
      getByName: (name: string) =>
        name === '@janhq/download-extension'
          ? {
              downloadFiles: async (
                items: unknown[],
                taskId: string,
                onProgress?: (t: number, total: number) => void
              ) => {
                transfers.push({ items, taskId })
                onProgress?.(1, 2)
              },
              cancelDownload: async (taskId: string) => {
                cancelled.push(taskId)
              },
            }
          : undefined,
    }
    ;(window as unknown as { core: unknown }).core = core
    seedServiceHub({
      app: { getJanDataFolder: async () => '/data' } as unknown as AppService,
      diffusion: {
        listModelFiles: async () => onDiskNow,
      } as unknown as DiffusionService,
    })
  })

  it('fetches only what is missing, under the artifact task id', async () => {
    const progress: number[] = []
    const plan = await downloadArtifact(zImage, 'q4_k_m', {
      onProgress: ({ transferred }) => progress.push(transferred),
    })

    expect(transfers).toHaveLength(1)
    expect(transfers[0].taskId).toBe('diffusion-model-z-image_q4_k_m')
    expect(transfers[0].items).toEqual([
      {
        url: 'https://huggingface.co/unsloth/Z-Image-Turbo-GGUF/resolve/main/z-image-turbo-Q4_K_M.gguf',
        save_path: `${ROOT}/z-image/z-image-turbo-Q4_K_M.gguf`,
        sha256: 'b'.repeat(64),
        size: 5_017_613_376,
        model_id: 'diffusion-model-z-image_q4_k_m',
      },
      {
        url: 'https://huggingface.co/unsloth/Z-Image-Turbo-ComfyUI/resolve/main/split_files/vae/ae.safetensors',
        save_path: `${ROOT}/${SHARED_AE}`,
        size: 335_304_388,
        model_id: 'diffusion-model-z-image_q4_k_m',
      },
    ])
    expect(progress).toEqual([1])
    expect(plan.entries.every((e) => e.present)).toBe(true)
    expect(plan.missingBytes).toBe(0)
  })

  it('does not transfer anything when the artifact is complete', async () => {
    onDiskNow = [
      onDisk('z-image/z-image-turbo-Q4_K_M.gguf', 5_017_613_376),
      onDisk(SHARED_AE, AE.bytes),
      onDisk(SHARED_TE, QWEN3.bytes),
    ]
    const plan = await downloadArtifact(zImage, 'q4_k_m')
    expect(transfers).toEqual([])
    expect(plan.missingBytes).toBe(0)
  })

  it('cancels under the same task id the panel shows', async () => {
    await cancelArtifactDownload('z-image:q4_k_m')
    expect(cancelled).toEqual(['diffusion-model-z-image_q4_k_m'])
  })
})
