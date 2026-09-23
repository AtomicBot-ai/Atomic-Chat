import { beforeEach, describe, expect, it, vi } from 'vitest'

import { DownloadEvent } from '@janhq/core'

import { seedServiceHub } from '@/test/service-hub'
import {
  findFamily,
  getBaselineDiffusionCatalog,
  type DiffusionCatalog,
  type DiffusionCatalogFamily,
} from '@/services/diffusion-catalog-registry'
import type {
  DiffusionModelFile,
  DiffusionService,
} from '@/services/diffusion/types'

import type { AppService } from '@/services/app/types'

import { LTX_2, WAN_22 } from './video-fixtures'
import {
  artifactId,
  buildLoadRequest,
  cancelArtifactDownload,
  deleteArtifact,
  diffusionDownloadTaskId,
  downloadArtifact,
  resolveDiffusionDownloadTaskId,
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

  it('resolves a sanitized task id through the catalog without splitting it', () => {
    const realism: DiffusionCatalogFamily = {
      ...zImage,
      id: 'flux.1-nsfw-realism',
      transformer: {
        ...zImage.transformer,
        quants: [
          {
            id: 'q8_0',
            label: 'Q8_0',
            filename: 'realism-Q8_0.gguf',
            bytes: 1,
          },
        ],
      },
    }
    const taskId = 'diffusion-model-flux_1-nsfw-realism_q8_0'

    expect(
      resolveDiffusionDownloadTaskId(
        { ...catalog, families: [...catalog.families, realism] },
        taskId
      )
    ).toMatchObject({
      artifactId: 'flux.1-nsfw-realism:q8_0',
      family: { id: 'flux.1-nsfw-realism' },
      quant: { id: 'q8_0' },
    })
  })

  it('refuses an unknown or ambiguous sanitized task id', () => {
    const ambiguous: DiffusionCatalogFamily = {
      ...zImage,
      transformer: {
        ...zImage.transformer,
        quants: [
          zImage.transformer.quants[0],
          {
            ...zImage.transformer.quants[0],
            id: 'q4.k.m',
          },
        ],
      },
    }
    expect(
      resolveDiffusionDownloadTaskId(catalog, 'diffusion-model-missing_q4')
    ).toBeNull()
    expect(
      resolveDiffusionDownloadTaskId(
        { ...catalog, families: [ambiguous] },
        'diffusion-model-z-image_q4_k_m'
      )
    ).toBeNull()
  })

  it('flattens a repo id into one shared folder name', () => {
    expect(sharedRepoDir('unsloth/FLUX.2-VAE')).toBe('unsloth--FLUX.2-VAE')
  })
})

describe('planArtifactDownload', () => {
  it('plans the exact verified Qwen-Image-2.1 artifact matrix', () => {
    const family = findFamily(
      getBaselineDiffusionCatalog(),
      'qwen-image-2.1'
    )!
    const plan = planArtifactDownload(family, 'q4_k', [], ROOT)

    expect(
      plan.entries.map(({ kind, repo, filename, bytes, sha256, field }) => ({
        kind,
        repo,
        filename,
        bytes,
        sha256,
        field,
      }))
    ).toEqual([
      {
        kind: 'transformer',
        repo: 'leejet/Qwen-Image-2.1-GGUF',
        filename: 'qwen_image_2.1-Q4_K.gguf',
        bytes: 4_197_494_816,
        sha256:
          '29f9c83c249ff0292fb2943fceddfa2319b446601866c82a4f8be062abea72c2',
        field: undefined,
      },
      {
        kind: 'vae',
        repo: 'Comfy-Org/Qwen-Image-2.1',
        filename: 'vae/qwen_image_2.1_vae_bf16.safetensors',
        bytes: 675_509_688,
        sha256:
          'bb21f7473051e1ac368515dd3f2e15cd44d7a11748ee8823e1ddca3e4876b7c9',
        field: undefined,
      },
      {
        kind: 'text_encoder',
        repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF',
        filename: 'Qwen3VL-8B-Instruct-Q4_K_M.gguf',
        bytes: 5_027_784_800,
        sha256:
          '67d1659bfe71b89d50b45a4ad1a9e5b997e5bb16ce5da66a6a6167abd569e9e2',
        field: 'llm',
      },
      {
        kind: 'text_encoder',
        repo: 'Qwen/Qwen3-VL-8B-Instruct-GGUF',
        filename: 'mmproj-Qwen3VL-8B-Instruct-F16.gguf',
        bytes: 1_159_029_824,
        sha256:
          'ca524100ebf825c9a870db1c580d03879e0da0ab2541697e2458e64891cf9d38',
        field: 'llm_vision',
      },
    ])
    expect(plan.entries.map((entry) => entry.required)).toEqual([
      true,
      true,
      true,
      false,
    ])
    expect(plan.totalBytes).toBe(9_900_789_304)

    const editPlan = planArtifactDownload(family, 'q4_k', [], ROOT, {
      workflow: 'edit',
    })
    expect(editPlan.entries.every((entry) => entry.required)).toBe(true)
    expect(editPlan.totalBytes).toBe(11_059_819_128)
  })

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

  it('calls a model complete without the optional vision projector a download never fetches', () => {
    const baseline = getBaselineDiffusionCatalog()
    const family = findFamily(baseline, 'qwen-image-2.1')!
    const plan = planArtifactDownload(family, 'q4_k', [], ROOT)
    // Exactly what `downloadArtifact` puts on disk for Create.
    const files = plan.entries
      .filter((entry) => entry.required)
      .map((entry) => onDisk(entry.relativePath, entry.bytes))
    expect(files).toHaveLength(plan.entries.length - 1)

    const installed = listInstalledArtifacts(baseline, files).find(
      (artifact) => artifact.id === 'qwen-image-2.1:q4_k'
    )
    expect(installed).toMatchObject({ complete: true, missing: [] })
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

  it('loads the Qwen Image 2.1 vision projector only for reference workflows', () => {
    const family = findFamily(
      getBaselineDiffusionCatalog(),
      'qwen-image-2.1'
    )!
    const create = buildLoadRequest(family, 'q4_k', [], ROOT, {
      offload: 'group',
      workflow: 'create',
    })
    expect(create.files.llm).toContain('Qwen3VL-8B-Instruct-Q4_K_M.gguf')
    expect(create.files.llmVision).toBeUndefined()

    const edit = buildLoadRequest(family, 'q4_k', [], ROOT, {
      offload: 'group',
      workflow: 'edit',
    })
    expect(edit.files.llmVision).toContain(
      'mmproj-Qwen3VL-8B-Instruct-F16.gguf'
    )
  })

  it('builds a Create-only Krea 2 Turbo load with transformer, Qwen3-VL and Wan VAE', () => {
    const family = findFamily(
      getBaselineDiffusionCatalog(),
      'krea-2-turbo'
    )!
    const request = buildLoadRequest(family, 'q4_k_m', [], ROOT, {
      offload: 'group',
      workflow: 'create',
    })

    expect(request).toMatchObject({
      modelId: 'krea-2-turbo:q4_k_m',
      family: 'krea-2-turbo',
      modality: 'image',
      displayName: 'Krea 2 Turbo Q4_K_M',
      files: {
        diffusionModel: `${ROOT}/krea-2-turbo/Krea-2-Turbo-Q4_K_M.gguf`,
        llm: `${ROOT}/shared/Qwen--Qwen3-VL-4B-Instruct-GGUF/Qwen3VL-4B-Instruct-Q4_K_M.gguf`,
        vae: `${ROOT}/shared/Comfy-Org--Wan_2.1_ComfyUI_repackaged/wan_2.1_vae.safetensors`,
      },
      defaults: {
        steps: 8,
        cfgScale: 1,
        samplingMethod: 'euler',
        width: 1024,
        height: 1024,
      },
      ranges: {
        steps: [1, 20],
        dims: [512, 2048],
        dimMultiple: 16,
      },
      offload: 'group',
    })
    expect(request.defaults.guidance).toBeUndefined()
    expect(request.files.llmVision).toBeUndefined()
    expect(request.files.qwen2vl).toBeUndefined()
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
  const transfers: Array<{
    items: unknown[]
    taskId: string
    resume: boolean
  }> = []
  const cancelled: string[] = []
  let onDiskNow: DiffusionModelFile[]
  let onTransfer:
    | ((items: Array<{ save_path: string }>, taskId: string) => Promise<void>)
    | undefined

  beforeEach(() => {
    transfers.length = 0
    cancelled.length = 0
    onTransfer = undefined
    onDiskNow = [onDisk(SHARED_TE, QWEN3.bytes)]
    const core = (globalThis as unknown as { core: Record<string, unknown> }).core
    core.extensionManager = {
      getByName: (name: string) =>
        name === '@janhq/download-extension'
          ? {
              downloadFiles: async (
                items: unknown[],
                taskId: string,
                onProgress?: (t: number, total: number) => void,
                resume = false
              ) => {
                transfers.push({ items, taskId, resume })
                onProgress?.(1, 2)
                await onTransfer?.(items as Array<{ save_path: string }>, taskId)
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
    expect(transfers[0].resume).toBe(false)
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

  it('passes resume through to the diffusion transfer', async () => {
    await downloadArtifact(zImage, 'q4_k_m', { resume: true })

    expect(transfers).toHaveLength(1)
    expect(transfers[0]).toMatchObject({
      taskId: 'diffusion-model-z-image_q4_k_m',
      resume: true,
    })
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

  it('leaves a shared file to the download already fetching it', async () => {
    onDiskNow = []
    let releaseFirst!: () => void
    onTransfer = async (items, taskId) => {
      if (taskId !== 'diffusion-model-z-image_q4_k_m') return
      await new Promise<void>((resolve) => (releaseFirst = resolve))
      onDiskNow = [
        ...onDiskNow,
        onDisk('z-image/z-image-turbo-Q4_K_M.gguf', 5_017_613_376),
        onDisk(SHARED_AE, AE.bytes),
        onDisk(SHARED_TE, QWEN3.bytes),
      ]
      expect(items).toHaveLength(3)
    }

    const first = downloadArtifact(zImage, 'q4_k_m')
    await vi.waitFor(() => expect(transfers).toHaveLength(1))
    const second = downloadArtifact(klein, 'q4_k_m')
    await vi.waitFor(() => expect(transfers).toHaveLength(2))

    // Two writers into one `.tmp` corrupt it; Klein must not list the encoder.
    expect(
      (transfers[1].items as Array<{ save_path: string }>).map(
        (item) => item.save_path
      )
    ).toEqual([
      `${ROOT}/flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf`,
      `${ROOT}/${SHARED_FLUX2_VAE}`,
    ])

    onDiskNow = [
      onDisk('flux.2-klein/flux-2-klein-4b-Q4_K_M.gguf', 2_604_311_104),
      onDisk(SHARED_FLUX2_VAE, 336_213_556),
    ]
    releaseFirst()
    await first
    const plan = await second
    expect(transfers).toHaveLength(2)
    expect(plan.missingBytes).toBe(0)
  })

  it('fetches a shared file itself when the download that had it fails', async () => {
    onDiskNow = []
    let failFirst!: (error: Error) => void
    onTransfer = async (items, taskId) => {
      if (taskId === 'diffusion-model-z-image_q4_k_m') {
        await new Promise<void>((_, reject) => (failFirst = reject))
        return
      }
      onDiskNow = [
        ...onDiskNow,
        ...items.map((item) =>
          onDisk(
            item.save_path.slice(ROOT.length + 1),
            item.save_path.endsWith('qwen_3_4b.safetensors')
              ? QWEN3.bytes
              : item.save_path.endsWith('flux2-vae.safetensors')
                ? 336_213_556
                : 2_604_311_104
          )
        ),
      ]
    }

    const first = downloadArtifact(zImage, 'q4_k_m')
    await vi.waitFor(() => expect(transfers).toHaveLength(1))
    const second = downloadArtifact(klein, 'q4_k_m')
    await vi.waitFor(() => expect(transfers).toHaveLength(2))

    failFirst(new Error('Download cancelled'))
    await expect(first).rejects.toThrow('Download cancelled')
    const plan = await second

    expect(transfers).toHaveLength(3)
    expect(transfers[2].taskId).toBe('diffusion-model-flux_2-klein_q4_k_m')
    expect(
      (transfers[2].items as Array<{ save_path: string }>).map(
        (item) => item.save_path
      )
    ).toEqual([`${ROOT}/${SHARED_TE}`])
    expect(plan.missingBytes).toBe(0)
  })

  it('reports a failed integrity check as a validation failure, not a transfer error', async () => {
    const emitted: string[] = []
    const core = (globalThis as unknown as { core: Record<string, unknown> }).core
    core.events = {
      on: () => {},
      off: () => {},
      emit: (name: string) => emitted.push(name),
    }
    onTransfer = async () => {
      throw new Error(
        'Size verification failed. Expected 10 bytes but got 4 bytes.'
      )
    }

    try {
      await expect(downloadArtifact(zImage, 'q4_k_m')).rejects.toThrow(
        'Size verification failed'
      )
      // The panel closes the "verifying…" toast only on this event.
      expect(emitted).toContain(DownloadEvent.onModelValidationFailed)
      expect(emitted).not.toContain(DownloadEvent.onFileDownloadError)
    } finally {
      delete core.events
    }
  })

  it('cancels under the same task id the panel shows', async () => {
    await cancelArtifactDownload('z-image:q4_k_m')
    expect(cancelled).toEqual(['diffusion-model-z-image_q4_k_m'])
  })
})

describe('video families', () => {
  const ltxShared = `shared/${sharedRepoDir('unsloth/LTX-2.3-GGUF')}`
  const gemmaShared = `shared/${sharedRepoDir('unsloth/gemma-3-12b-it-qat-GGUF')}`

  it('plans the audio VAE and the connectors as shared side files', () => {
    const plan = planArtifactDownload(LTX_2, 'q4_k_m', [], ROOT)
    expect(plan.entries.map((e) => [e.kind, e.relativePath])).toEqual([
      ['transformer', 'ltx-2/ltx-2.3-22b-distilled-Q4_K_M.gguf'],
      ['vae', `${ltxShared}/ltx-2.3-22b-distilled_video_vae.safetensors`],
      ['audio_vae', `${ltxShared}/ltx-2.3-22b-distilled_audio_vae.safetensors`],
      ['text_encoder', `${gemmaShared}/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf`],
      ['text_encoder', `${ltxShared}/ltx-2.3-22b-distilled_embeddings_connectors.safetensors`],
    ])
    expect(plan.entries.every((e) => e.required)).toBe(true)
    expect(plan.totalBytes).toBe(
      14_000_000_000 + 1_400_000_000 + 360_000_000 + 7_400_000_000 + 2_300_000_000
    )
  })

  it('maps the video files, the sigma schedule, the video defaults and the frame range onto the load request', () => {
    const files = planArtifactDownload(LTX_2, 'q4_k_m', [], ROOT).entries.map((e) => ({
      path: e.savePath,
      relativePath: e.relativePath,
      bytes: e.bytes,
    }))
    const request = buildLoadRequest(LTX_2, 'q4_k_m', files, ROOT, { offload: 'group' })
    expect(request).toEqual({
      modelId: 'ltx-2:q4_k_m',
      family: 'ltx-2',
      modality: 'video',
      displayName: 'LTX-2.3 Distilled Q4_K_M',
      files: {
        diffusionModel: `${ROOT}/ltx-2/ltx-2.3-22b-distilled-Q4_K_M.gguf`,
        vae: `${ROOT}/${ltxShared}/ltx-2.3-22b-distilled_video_vae.safetensors`,
        audioVae: `${ROOT}/${ltxShared}/ltx-2.3-22b-distilled_audio_vae.safetensors`,
        llm: `${ROOT}/${gemmaShared}/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf`,
        embeddingsConnectors: `${ROOT}/${ltxShared}/ltx-2.3-22b-distilled_embeddings_connectors.safetensors`,
      },
      defaults: {
        steps: 8,
        cfgScale: 1,
        samplingMethod: 'euler',
        width: 768,
        height: 512,
        sigmas: [1, 0.99375, 0.9875, 0.98125, 0.975, 0.909375, 0.725, 0.421875],
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
      ranges: { steps: [1, 50], dims: [256, 1216], dimMultiple: 32, frames: [9, 257] },
      offload: 'group',
    })
    const wan = buildLoadRequest(WAN_22, 'q4_k_m', [], ROOT, { offload: 'none' })
    expect(wan.files.t5xxl).toContain('umt5-xxl-encoder-Q4_K_M.gguf')
    expect(wan.files).not.toHaveProperty('audioVae')
    expect(wan.defaults).toMatchObject({ flowShift: 5, video: { fps: 24, frameStep: 4, frameOffset: 1 } })
    expect(wan.defaults).not.toHaveProperty('sigmas')
    expect(wan.ranges.frames).toEqual([5, 241])
  })

  it('keeps the shared audio VAE while another quant of the family still needs it', () => {
    const catalog = { schema_version: 1, updated_at: '2026-09-23', families: [LTX_2] }
    const files = [
      ...planArtifactDownload(LTX_2, 'q4_k_m', [], '').entries,
      ...planArtifactDownload(LTX_2, 'q8_0', [], '').entries,
    ].map((e) => ({ path: `/m/${e.relativePath}`, relativePath: e.relativePath, bytes: e.bytes }))
    const { remove, kept } = planArtifactDeletion(LTX_2, 'q4_k_m', files, catalog)
    expect(remove.map((f) => f.relativePath)).toEqual(['ltx-2/ltx-2.3-22b-distilled-Q4_K_M.gguf'])
    expect(kept.map((f) => f.relativePath)).toEqual([
      `${ltxShared}/ltx-2.3-22b-distilled_video_vae.safetensors`,
      `${ltxShared}/ltx-2.3-22b-distilled_audio_vae.safetensors`,
      `${gemmaShared}/gemma-3-12b-it-qat-UD-Q4_K_XL.gguf`,
      `${ltxShared}/ltx-2.3-22b-distilled_embeddings_connectors.safetensors`,
    ])
  })
})
