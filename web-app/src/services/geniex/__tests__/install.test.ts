import { describe, expect, it, vi } from 'vitest'

import {
  GeniexModelRefusedError,
  GeniexNotReadyError,
  installGeniexModel,
  type GeniexInstallDeps,
} from '../install'
import { geniexDownloadId } from '@/lib/geniex/download-id'
import { GatedModelError, InsufficientModelSpaceError } from '@/services/managed-models/models'
import type { TransferItem, TransferOptions } from '@/services/diffusion/transfer'
import type { GeniexCheckRequest, GeniexCheckResult, GeniexHubModel, GeniexHubVariant } from '../types'

const SHA = 'a'.repeat(64)
const MMPROJ_SHA = 'c'.repeat(64)
const REVISION = 'b'.repeat(40)
const BUNDLE_URL = 'https://qaihub-public-assets.s3.us-west-2.amazonaws.com/qai-hub-models/qwen3-4b/x-elite.zip'

const gemma: GeniexHubModel = {
  origin: 'curated',
  kind: 'gguf',
  model_id: 'gemma-4-e4b',
  name: 'Gemma 4 E4B',
  summary: 'Gemma 4',
  license: 'apache-2.0',
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: true,
  gguf: {
    repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
    revision: REVISION,
    gated: false,
    file: { path: 'gemma-4-E4B_q4_0-it.gguf', size: 5_000_000_000, sha256: SHA },
    mmproj: { path: 'gemma-4-E4B-it-mmproj.gguf', size: 1_000_000_000, sha256: MMPROJ_SHA },
    devices: ['npu', 'gpu', 'cpu', 'hybrid'],
    platforms: ['win-arm64'],
  },
}

const hfQwen: GeniexHubModel = {
  origin: 'huggingface',
  kind: 'gguf',
  model_id: 'qwen3-4b-gguf',
  name: 'Qwen3-4B-GGUF',
  summary: 'unsloth/Qwen3-4B-GGUF',
  license: 'apache-2.0',
  gguf: {
    repo: 'unsloth/Qwen3-4B-GGUF',
    revision: REVISION,
    gated: false,
    file: { path: 'Qwen3-4B-Q4_0.gguf', size: 2_375_773_472, sha256: SHA },
    devices: ['npu', 'gpu', 'cpu', 'hybrid'],
    platforms: ['win-arm64'],
  },
}

const xElite: GeniexHubVariant = {
  id: 'qwen3-4b-aihub-x-elite',
  chip: 'x-elite',
  bundle: { url: BUNDLE_URL, size: 2_500_000_000, sha256: SHA },
  precision: 'w4a16',
  min_runtime_version: '0.9.3',
}
const bundleModel: GeniexHubModel = {
  origin: 'curated',
  kind: 'qairt',
  model_id: 'qwen3-4b-aihub',
  name: 'Qwen3 4B (AI Hub)',
  summary: 'Compiled by Qualcomm AI Hub',
  license: 'apache-2.0',
  context_length: 4096,
  tools: true,
  reasoning: false,
  vision: false,
  variants: [xElite],
}

const GGUF_OK: GeniexCheckResult = {
  verdict: 'ok',
  reason: null,
  metadata: {
    kind: 'gguf',
    architecture: 'qwen3',
    max_context_tokens: 40960,
    quantization: 'Q4_0',
    chat_template: true,
    vision: false,
  },
}
const BUNDLE_OK: GeniexCheckResult = {
  verdict: 'ok',
  reason: null,
  metadata: { kind: 'qairt', chip: 'x-elite', max_context_tokens: 4096, precision: 'w4a16', min_runtime_version: '0.9.3' },
}

function fakeDeps(overrides: Partial<GeniexInstallDeps> = {}, onDisk: (request: GeniexCheckRequest) => GeniexCheckResult = () => GGUF_OK) {
  const steps: string[] = []
  const transfers: Array<{ items: TransferItem[]; taskId: string; options: TransferOptions }> = []
  const extractions: Array<{ archive: string; outputDir: string; taskId: string }> = []
  const yaml: Array<{ path: string; data: Record<string, unknown> }> = []
  const checks: GeniexCheckRequest[] = []
  const deps: GeniexInstallDeps = {
    check: vi.fn(async (request: GeniexCheckRequest) => {
      checks.push(request)
      steps.push(request.path ? 'check on disk' : 'check variant')
      return request.path ? onDisk(request) : { verdict: 'ok', reason: null }
    }),
    dataFolder: async () => '/data',
    existingSize: async () => null,
    hasPartial: async () => false,
    isUnpacked: async () => false,
    freeSpace: async () => ({ available: 100e9, headroom: 1e9 }),
    transfer: vi.fn(async (items: TransferItem[], taskId: string, options: TransferOptions) => {
      steps.push('transfer')
      transfers.push({ items, taskId, options })
    }),
    extractZip: vi.fn(async (archive: string, outputDir: string, taskId: string) => {
      steps.push('extract')
      extractions.push({ archive, outputDir, taskId })
      return { files: 3, bytes: 2_400_000_000 }
    }),
    removeFolder: vi.fn(async (path: string) => {
      steps.push(`rm ${path}`)
    }),
    writeYaml: vi.fn(async (path: string, data: unknown) => {
      steps.push('model.yml')
      yaml.push({ path, data: data as Record<string, unknown> })
    }),
    emit: vi.fn(),
    proxy: () => undefined,
    ...overrides,
  }
  return { deps, steps, transfers, extractions, yaml, checks }
}

const ROOT = '/data/geniex/models'

describe('installGeniexModel — a GGUF model', () => {
  it('asks the verdict for the device, downloads the file and its projector as one task, checks the file by path and writes model.yml last', async () => {
    // spec geniex-desktop "Скачивание Gemma 4 E4B": one task with two files.
    const { deps, steps, transfers, yaml, checks } = fakeDeps()

    const result = await installGeniexModel({ model: gemma, device: 'npu' }, deps)

    expect(result).toEqual({ modelId: 'gemma-4-e4b' })
    expect(steps).toEqual(['check variant', 'transfer', 'check on disk', 'model.yml'])
    expect(checks).toEqual([
      { plugin: 'llama_cpp', device: 'npu' },
      { path: `${ROOT}/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf`, plugin: 'llama_cpp', device: 'npu' },
    ])
    expect(transfers[0].taskId).toBe(geniexDownloadId('gemma-4-e4b'))
    expect(transfers[0].items).toEqual([
      {
        url: `https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/${REVISION}/gemma-4-E4B_q4_0-it.gguf`,
        save_path: `${ROOT}/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf`,
        size: 5_000_000_000,
        sha256: SHA,
        model_id: 'geniex-gemma-4-e4b',
        resume_key: 'geniex/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf',
      },
      {
        url: `https://huggingface.co/google/gemma-4-E4B-it-qat-q4_0-gguf/resolve/${REVISION}/gemma-4-E4B-it-mmproj.gguf`,
        save_path: `${ROOT}/gemma-4-e4b/gemma-4-E4B-it-mmproj.gguf`,
        size: 1_000_000_000,
        sha256: MMPROJ_SHA,
        model_id: 'geniex-gemma-4-e4b',
        resume_key: 'geniex/gemma-4-e4b/gemma-4-E4B-it-mmproj.gguf',
      },
    ])
    expect(transfers[0].options.resume).toBe(true)
    expect(transfers[0].options.hfToken).toBeUndefined()
    expect(yaml).toEqual([
      {
        path: `${ROOT}/gemma-4-e4b/model.yml`,
        data: {
          model_path: 'geniex/models/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf',
          mmproj_path: 'geniex/models/gemma-4-e4b/gemma-4-E4B-it-mmproj.gguf',
          name: 'Gemma 4 E4B',
          size_bytes: 6_000_000_000,
          geniex: {
            model_id: 'gemma-4-e4b',
            variant_id: 'gemma-4-e4b',
            plugin: 'llama_cpp',
            backend: 'npu',
            repo: 'google/gemma-4-E4B-it-qat-q4_0-gguf',
            revision: REVISION,
            file: 'gemma-4-E4B_q4_0-it.gguf',
            mmproj: 'gemma-4-E4B-it-mmproj.gguf',
            context_length: 32768,
            tools: true,
            reasoning: true,
            vision: true,
            source: 'curated',
          },
        },
      },
    ])
  })

  it('hands the person’s token to the shared downloader, which sends it to Hugging Face hosts only, and downloads through the proxy', async () => {
    const proxy = { url: 'http://proxy.corp:3128', no_proxy: ['localhost'] }
    const { deps, transfers } = fakeDeps({ proxy: () => proxy })

    await installGeniexModel({ model: gemma, device: 'gpu', hfToken: 'hf_x' }, deps)

    expect(transfers[0].options.hfToken).toBe('hf_x')
    expect(transfers[0].items.map((item) => item.proxy)).toEqual([proxy, proxy])
  })

  it('writes a Hugging Face model’s facts from the core’s check of the file: context and vision from the header, no tool calling claimed', async () => {
    // spec geniex-models: "Для модели с Hugging Face признаки SHALL браться из метаданных в ответе
    // проверки core". The header names no tool calling, so none is claimed (rulings/app.md).
    const { deps, yaml } = fakeDeps()

    await installGeniexModel({ model: hfQwen, device: 'cpu' }, deps)

    expect(yaml[0].data).toMatchObject({
      model_path: 'geniex/models/qwen3-4b-gguf/Qwen3-4B-Q4_0.gguf',
      name: 'Qwen3-4B-GGUF',
      size_bytes: 2_375_773_472,
      geniex: {
        model_id: 'qwen3-4b-gguf',
        backend: 'cpu',
        context_length: 40960,
        tools: false,
        reasoning: false,
        vision: false,
        source: 'huggingface',
      },
    })
    expect(yaml[0].data).not.toHaveProperty('mmproj_path')
  })

  it('claims vision for a Hugging Face model by the projector it downloaded, whatever the header reading says', async () => {
    // Google's QAT repositories name the projector `…-mmproj.gguf`, which the core's `mmproj*.gguf`
    // reading misses; the host still gets `--mmproj` from model.yml.
    const { deps, yaml } = fakeDeps()
    const gemmaFromHf: GeniexHubModel = { ...hfQwen, model_id: 'gemma-4-e2b-it-qat-q4_0-gguf', gguf: gemma.gguf }

    await installGeniexModel({ model: gemmaFromHf, device: 'npu' }, deps)

    expect(yaml[0].data).toMatchObject({
      mmproj_path: 'geniex/models/gemma-4-e2b-it-qat-q4_0-gguf/gemma-4-E4B-it-mmproj.gguf',
      geniex: { vision: true, mmproj: 'gemma-4-E4B-it-mmproj.gguf', source: 'huggingface' },
    })
  })

  it('does not start a gated model’s download without a token, and links its repository', async () => {
    const { deps, steps } = fakeDeps()
    const gated = { ...hfQwen, gguf: { ...hfQwen.gguf!, gated: true } }

    const install = installGeniexModel({ model: gated, device: 'npu' }, deps)

    await expect(install).rejects.toBeInstanceOf(GatedModelError)
    await expect(install).rejects.toMatchObject({ url: 'https://huggingface.co/unsloth/Qwen3-4B-GGUF' })
    expect(steps).toEqual([])
  })

  it('turns a 401 or 403 into the gated-model error and leaves nothing of the model', async () => {
    // spec geniex-models: "MUST NOT оставлять частично записанную модель".
    const { deps, steps } = fakeDeps({
      transfer: vi.fn(async () => {
        steps.push('transfer')
        throw new Error('Failed to download: HTTP status 403 Forbidden')
      }),
    })

    await expect(installGeniexModel({ model: hfQwen, device: 'npu', hfToken: 'hf_x' }, deps)).rejects.toBeInstanceOf(
      GatedModelError
    )
    expect(steps).toEqual(['check variant', 'transfer', `rm ${ROOT}/qwen3-4b-gguf`])
  })

  it('downloads nothing when the core says the device cannot run here yet', async () => {
    const { deps, steps } = fakeDeps({
      check: vi.fn(async () => {
        steps.push('check variant')
        return { verdict: 'engine-not-installed', reason: 'Install GenieX first.' } as GeniexCheckResult
      }),
    })

    const install = installGeniexModel({ model: gemma, device: 'npu' }, deps)

    await expect(install).rejects.toBeInstanceOf(GeniexNotReadyError)
    await expect(install).rejects.toMatchObject({ check: { verdict: 'engine-not-installed' } })
    expect(steps).toEqual(['check variant'])
  })

  it('writes no model.yml when a file fails its sha256', async () => {
    // spec geniex-models "Подменённый файл".
    const { deps, steps, yaml } = fakeDeps({
      transfer: vi.fn(async () => {
        steps.push('transfer')
        throw new Error('Hash verification failed for gemma-4-E4B_q4_0-it.gguf')
      }),
    })

    await expect(installGeniexModel({ model: gemma, device: 'npu' }, deps)).rejects.toThrow(/Hash verification failed/)
    expect(yaml).toEqual([])
    expect(steps).toEqual(['check variant', 'transfer'])
  })

  it('removes the model’s folder and says why when the core refuses the downloaded file', async () => {
    const refused: GeniexCheckResult = {
      verdict: 'platform-unsupported',
      reason: 'This file is not a GGUF the llama_cpp plugin loads.',
    }
    const { deps, steps, yaml } = fakeDeps({}, () => refused)

    const install = installGeniexModel({ model: gemma, device: 'npu' }, deps)

    await expect(install).rejects.toBeInstanceOf(GeniexModelRefusedError)
    await expect(install).rejects.toThrow('This file is not a GGUF the llama_cpp plugin loads.')
    expect(yaml).toEqual([])
    expect(steps).toEqual(['check variant', 'transfer', 'check on disk', `rm ${ROOT}/gemma-4-e4b`])
  })

  it('refuses before downloading when the disk has no room for the files', async () => {
    const { deps, steps } = fakeDeps({ freeSpace: async () => ({ available: 2e9, headroom: 1e9 }) })

    await expect(installGeniexModel({ model: gemma, device: 'npu' }, deps)).rejects.toBeInstanceOf(
      InsufficientModelSpaceError
    )
    expect(steps).toEqual(['check variant'])
  })

  it('does not fetch files already complete on disk, and checks and records them', async () => {
    const sizes: Record<string, number> = {
      [`${ROOT}/gemma-4-e4b/gemma-4-E4B_q4_0-it.gguf`]: 5_000_000_000,
      [`${ROOT}/gemma-4-e4b/gemma-4-E4B-it-mmproj.gguf`]: 1_000_000_000,
    }
    const { deps, steps } = fakeDeps({ existingSize: async (path) => sizes[path] ?? null })

    await installGeniexModel({ model: gemma, device: 'npu' }, deps)

    expect(steps).toEqual(['check variant', 'check on disk', 'model.yml'])
  })
})

describe('installGeniexModel — an AI Hub bundle', () => {
  it('asks the verdict for the chip, downloads the zip, unpacks it under the same task, checks the folder with the chip and writes model.yml last', async () => {
    // spec geniex-models "Бандл скачан и распакован"; the check by path carries conf's chip
    // (core rulings 6.5).
    const { deps, steps, transfers, extractions, yaml, checks } = fakeDeps({}, () => BUNDLE_OK)

    const result = await installGeniexModel({ model: bundleModel, variant: xElite }, deps)

    expect(result).toEqual({ modelId: 'qwen3-4b-aihub-x-elite' })
    expect(steps).toEqual(['check variant', 'transfer', 'extract', 'check on disk', 'model.yml'])
    expect(checks).toEqual([
      { plugin: 'qairt', device: 'npu', chip: 'x-elite', min_runtime_version: '0.9.3' },
      { path: `${ROOT}/qwen3-4b-aihub-x-elite`, plugin: 'qairt', device: 'npu', chip: 'x-elite' },
    ])
    expect(transfers[0].taskId).toBe('geniex-qwen3-4b-aihub-x-elite')
    expect(transfers[0].items).toEqual([
      {
        url: BUNDLE_URL,
        save_path: `${ROOT}/qwen3-4b-aihub-x-elite/bundle.zip`,
        size: 2_500_000_000,
        sha256: SHA,
        model_id: 'geniex-qwen3-4b-aihub-x-elite',
        resume_key: 'geniex/qwen3-4b-aihub-x-elite/bundle.zip',
      },
    ])
    // No token for Qualcomm's S3, whatever the person set (spec "Токен не уходит на чужой хост").
    expect(transfers[0].options.hfToken).toBeUndefined()
    expect(extractions).toEqual([
      {
        archive: `${ROOT}/qwen3-4b-aihub-x-elite/bundle.zip`,
        outputDir: `${ROOT}/qwen3-4b-aihub-x-elite`,
        taskId: 'geniex-qwen3-4b-aihub-x-elite',
      },
    ])
    expect(yaml).toEqual([
      {
        path: `${ROOT}/qwen3-4b-aihub-x-elite/model.yml`,
        data: {
          model_path: 'geniex/models/qwen3-4b-aihub-x-elite',
          name: 'Qwen3 4B (AI Hub)',
          size_bytes: 2_400_000_000,
          geniex: {
            model_id: 'qwen3-4b-aihub',
            variant_id: 'qwen3-4b-aihub-x-elite',
            plugin: 'qairt',
            backend: 'npu',
            chip: 'x-elite',
            bundle_url: BUNDLE_URL,
            precision: 'w4a16',
            context_length: 4096,
            tools: true,
            reasoning: false,
            vision: false,
            source: 'curated',
          },
        },
      },
    ])
  })

  it('never hands a token to the bundle’s download, even when the person set one', async () => {
    const { deps, transfers } = fakeDeps({}, () => BUNDLE_OK)

    await installGeniexModel({ model: bundleModel, variant: xElite, hfToken: 'hf_x' }, deps)

    expect(transfers[0].options.hfToken).toBeUndefined()
  })

  it('removes the folder and says why when the core refuses the unpacked bundle (another chip)', async () => {
    // spec geniex-runtime "Бандл под другой чип".
    const refused: GeniexCheckResult = {
      verdict: 'platform-unsupported',
      reason: 'This bundle is built for the Snapdragon x2-elite; this computer has the x-elite.',
      metadata: { ...BUNDLE_OK.metadata!, chip: 'x2-elite' } as GeniexCheckResult['metadata'],
    }
    const { deps, steps, yaml } = fakeDeps({}, () => refused)

    const install = installGeniexModel({ model: bundleModel, variant: xElite }, deps)

    await expect(install).rejects.toBeInstanceOf(GeniexModelRefusedError)
    expect(yaml).toEqual([])
    expect(steps).toEqual(['check variant', 'transfer', 'extract', 'check on disk', `rm ${ROOT}/qwen3-4b-aihub-x-elite`])
  })

  it('writes no model.yml when the zip fails its sha256, and unpacks nothing', async () => {
    const { deps, steps, extractions } = fakeDeps({
      transfer: vi.fn(async () => {
        steps.push('transfer')
        throw new Error('Hash verification failed for bundle.zip')
      }),
    })

    await expect(installGeniexModel({ model: bundleModel, variant: xElite }, deps)).rejects.toThrow(/Hash verification/)
    expect(extractions).toEqual([])
    expect(steps).toEqual(['check variant', 'transfer'])
  })

  it('skips the download and the unpacking of a bundle already unpacked, and checks and records it', async () => {
    const { deps, steps } = fakeDeps({ isUnpacked: async () => true }, () => BUNDLE_OK)

    await installGeniexModel({ model: bundleModel, variant: xElite }, deps)

    expect(steps).toEqual(['check variant', 'check on disk', 'model.yml'])
  })

  it('unpacks again a bundle whose archive is still there: a cancelled unpack may have written genie_config.json', async () => {
    const { deps, steps } = fakeDeps(
      { isUnpacked: async () => true, existingSize: async () => 2_500_000_000 },
      () => BUNDLE_OK
    )

    await installGeniexModel({ model: bundleModel, variant: xElite }, deps)

    expect(steps).toEqual(['check variant', 'extract', 'check on disk', 'model.yml'])
  })
})
