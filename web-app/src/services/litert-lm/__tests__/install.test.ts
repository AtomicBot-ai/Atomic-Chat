import { describe, expect, it, vi } from 'vitest'

import {
  LiteRtLmFileRefusedError,
  LiteRtLmNotReadyError,
  installLiteRtLmVariant,
  type LiteRtLmInstallDeps,
} from '../install'
import { liteRtLmDownloadId } from '@/lib/litert-lm/download-id'
import { GatedModelError, InsufficientModelSpaceError } from '@/services/managed-models/models'
import type { TransferItem, TransferOptions } from '@/services/diffusion/transfer'
import type { LiteRtLmCheckRequest, LiteRtLmCheckResult, LiteRtLmHubModel, LiteRtLmHubVariant } from '../types'

const SHA = 'a'.repeat(64)
const REVISION = 'b'.repeat(40)

const gpu: LiteRtLmHubVariant = {
  id: 'gemma-4-e4b-gpu',
  backend: 'gpu',
  platforms: ['macos-arm64'],
  file: { path: 'gemma-4-E4B-it.litertlm', size: 3_650_000_000, sha256: SHA },
}
const curated: LiteRtLmHubModel = {
  origin: 'curated',
  model_id: 'gemma-4-e4b',
  name: 'Gemma 4 E4B',
  summary: 'Gemma 4',
  license: 'apache-2.0',
  repo: 'litert-community/gemma-4-E4B-it-litert-lm',
  revision: REVISION,
  gated: false,
  context_length: 32768,
  tools: true,
  reasoning: true,
  vision: true,
  variants: [gpu],
}

const hfCpu: LiteRtLmHubVariant = {
  id: 'qwen3_4b_mixed_int4-cpu',
  backend: 'cpu',
  platforms: ['macos-arm64'],
  file: { path: 'qwen3_4b_mixed_int4.litertlm', size: 2_659_053_760, sha256: SHA },
}
const hfModel: LiteRtLmHubModel = {
  origin: 'huggingface',
  model_id: 'litert-community/Qwen3-4B',
  name: 'Qwen3-4B',
  summary: 'litert-community/Qwen3-4B',
  license: 'apache-2.0',
  repo: 'litert-community/Qwen3-4B',
  revision: REVISION,
  gated: false,
  variants: [hfCpu],
}

const FILE_OK: LiteRtLmCheckResult = {
  verdict: 'ok',
  reason: null,
  metadata: {
    model_type: 'llm',
    max_context_tokens: 2048,
    dynamic_context: false,
    function_calling: true,
    thinking: true,
    modalities: ['text'],
    backends: ['cpu', 'gpu'],
    vision_backends: [],
    npu: null,
    speculative_decoding: false,
    min_runtime_version: null,
  },
}

function fakeDeps(overrides: Partial<LiteRtLmInstallDeps> = {}, fileCheck: LiteRtLmCheckResult = FILE_OK) {
  const steps: string[] = []
  const transfers: Array<{ items: TransferItem[]; taskId: string; options: TransferOptions }> = []
  const yaml: Array<{ path: string; data: Record<string, unknown> }> = []
  const checks: LiteRtLmCheckRequest[] = []
  const deps: LiteRtLmInstallDeps = {
    check: vi.fn(async (request: LiteRtLmCheckRequest) => {
      checks.push(request)
      steps.push(request.path ? 'check file' : 'check variant')
      return request.path ? fileCheck : { verdict: 'ok', reason: null }
    }),
    dataFolder: async () => '/data',
    existingSize: async () => null,
    hasPartial: async () => false,
    freeSpace: async () => ({ available: 100e9, headroom: 1e9 }),
    transfer: vi.fn(async (items: TransferItem[], taskId: string, options: TransferOptions) => {
      steps.push('transfer')
      transfers.push({ items, taskId, options })
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
  return { deps, steps, transfers, yaml, checks }
}

const ROOT = '/data/litert-lm/models'

describe('installLiteRtLmVariant', () => {
  it('asks the verdict, downloads the file as one task, checks it by path and writes model.yml last', async () => {
    const { deps, steps, transfers, yaml, checks } = fakeDeps()

    const result = await installLiteRtLmVariant({ model: curated, variant: gpu }, deps)

    expect(result).toEqual({ modelId: 'gemma-4-e4b-gpu' })
    expect(steps).toEqual(['check variant', 'transfer', 'check file', 'model.yml'])
    expect(checks).toEqual([
      { backend: 'gpu' },
      { path: `${ROOT}/gemma-4-e4b-gpu/gemma-4-E4B-it.litertlm`, backend: 'gpu' },
    ])
    expect(transfers[0].taskId).toBe(liteRtLmDownloadId('gemma-4-e4b-gpu'))
    expect(transfers[0].items).toEqual([
      {
        url: `https://huggingface.co/litert-community/gemma-4-E4B-it-litert-lm/resolve/${REVISION}/gemma-4-E4B-it.litertlm`,
        save_path: `${ROOT}/gemma-4-e4b-gpu/gemma-4-E4B-it.litertlm`,
        size: 3_650_000_000,
        sha256: SHA,
        model_id: 'litert-lm-gemma-4-e4b-gpu',
        resume_key: 'litert-lm/gemma-4-e4b-gpu/gemma-4-E4B-it.litertlm',
      },
    ])
    expect(transfers[0].options.resume).toBe(true)
    expect(transfers[0].options.hfToken).toBeUndefined()
    expect(yaml).toEqual([
      {
        path: `${ROOT}/gemma-4-e4b-gpu/model.yml`,
        data: {
          model_path: 'litert-lm/models/gemma-4-e4b-gpu/gemma-4-E4B-it.litertlm',
          name: 'Gemma 4 E4B (GPU)',
          size_bytes: 3_650_000_000,
          litert_lm: {
            model_id: 'gemma-4-e4b',
            variant_id: 'gemma-4-e4b-gpu',
            backend: 'gpu',
            repo: 'litert-community/gemma-4-E4B-it-litert-lm',
            revision: REVISION,
            file: 'gemma-4-E4B-it.litertlm',
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

  it('hands the person’s token to the shared downloader, which sends it to Hugging Face hosts only', async () => {
    const { deps, transfers } = fakeDeps()

    await installLiteRtLmVariant({ model: curated, variant: gpu, hfToken: 'hf_x' }, deps)

    expect(transfers[0].options.hfToken).toBe('hf_x')
  })

  it('downloads through the proxy set in Settings', async () => {
    const proxy = { url: 'http://proxy.corp:3128', no_proxy: ['localhost'] }
    const { deps, transfers } = fakeDeps({ proxy: () => proxy })

    await installLiteRtLmVariant({ model: curated, variant: gpu }, deps)

    expect(transfers[0].items[0].proxy).toEqual(proxy)
  })

  it('writes a Hugging Face model’s abilities from the core’s check of the file', async () => {
    const { deps, yaml } = fakeDeps()

    await installLiteRtLmVariant({ model: hfModel, variant: hfCpu }, deps)

    expect(yaml[0].data).toMatchObject({
      name: 'Qwen3-4B (CPU)',
      litert_lm: {
        model_id: 'litert-community/Qwen3-4B',
        context_length: 2048,
        tools: true,
        reasoning: true,
        vision: false,
        source: 'huggingface',
      },
    })
  })

  it('names the NPU generation of an NPU variant in model.yml and in the checks', async () => {
    const npu: LiteRtLmHubVariant = { ...gpu, id: 'gemma-4-e2b-npu-lnl', backend: 'npu', npu: 'intel-lnl', min_runtime_version: '0.18' }
    const { deps, yaml, checks } = fakeDeps()

    await installLiteRtLmVariant({ model: curated, variant: npu }, deps)

    expect(checks[0]).toEqual({ backend: 'npu', npu: 'intel-lnl', min_runtime_version: '0.18' })
    expect(checks[1]).toMatchObject({ backend: 'npu', npu: 'intel-lnl' })
    expect(yaml[0].data).toMatchObject({ name: 'Gemma 4 E4B (NPU intel-lnl)', litert_lm: { backend: 'npu', npu: 'intel-lnl' } })
  })

  it('does not start a gated model’s download without a token, and links its repository', async () => {
    // spec litert-lm-models "Закрытая модель без токена".
    const { deps, steps } = fakeDeps()

    const install = installLiteRtLmVariant({ model: { ...hfModel, gated: true }, variant: hfCpu }, deps)

    await expect(install).rejects.toBeInstanceOf(GatedModelError)
    await expect(install).rejects.toMatchObject({ url: 'https://huggingface.co/litert-community/Qwen3-4B' })
    expect(steps).toEqual([])
  })

  it('turns a 401 or 403 into the gated-model error and leaves nothing of the variant', async () => {
    const { deps, steps } = fakeDeps({
      transfer: vi.fn(async () => {
        steps.push('transfer')
        throw new Error('Failed to download: HTTP status 403 Forbidden')
      }),
    })

    await expect(
      installLiteRtLmVariant({ model: { ...hfModel, gated: true }, variant: hfCpu, hfToken: 'hf_x' }, deps)
    ).rejects.toBeInstanceOf(GatedModelError)
    expect(steps).toEqual(['check variant', 'transfer', `rm ${ROOT}/qwen3_4b_mixed_int4-cpu`])
  })

  it('downloads nothing when the core says the variant cannot run here yet', async () => {
    const { deps, steps } = fakeDeps({
      check: vi.fn(async () => {
        steps.push('check variant')
        return { verdict: 'engine-not-installed', reason: 'Install LiteRT-LM first.' } as LiteRtLmCheckResult
      }),
    })

    const install = installLiteRtLmVariant({ model: curated, variant: gpu }, deps)

    await expect(install).rejects.toBeInstanceOf(LiteRtLmNotReadyError)
    await expect(install).rejects.toMatchObject({ check: { verdict: 'engine-not-installed' } })
    expect(steps).toEqual(['check variant'])
  })

  it('writes no model.yml when the file fails its sha256', async () => {
    const { deps, steps, yaml } = fakeDeps({
      transfer: vi.fn(async () => {
        steps.push('transfer')
        throw new Error('Hash verification failed for gemma-4-E4B-it.litertlm')
      }),
    })

    await expect(installLiteRtLmVariant({ model: curated, variant: gpu }, deps)).rejects.toThrow(/Hash verification failed/)
    expect(yaml).toEqual([])
    expect(steps).toEqual(['check variant', 'transfer'])
  })

  it('removes the variant’s folder and says why when the core refuses the downloaded file', async () => {
    // spec litert-lm-runtime "Скачанный файл без GPU".
    const refused: LiteRtLmCheckResult = {
      verdict: 'platform-unsupported',
      reason: 'The file runs on cpu only, not on gpu.',
      metadata: { ...FILE_OK.metadata!, backends: ['cpu'] },
    }
    const { deps, steps, yaml } = fakeDeps({}, refused)

    const install = installLiteRtLmVariant({ model: curated, variant: gpu }, deps)

    await expect(install).rejects.toBeInstanceOf(LiteRtLmFileRefusedError)
    await expect(install).rejects.toThrow('The file runs on cpu only, not on gpu.')
    expect(yaml).toEqual([])
    expect(steps).toEqual(['check variant', 'transfer', 'check file', `rm ${ROOT}/gemma-4-e4b-gpu`])
  })

  it('keeps a file the core says needs its accelerator prepared', async () => {
    const { deps, yaml } = fakeDeps({}, { ...FILE_OK, verdict: 'accelerator-not-prepared', reason: 'Prepare OpenVINO.' })

    await installLiteRtLmVariant({ model: curated, variant: gpu }, deps)

    expect(yaml).toHaveLength(1)
  })

  it('refuses before downloading when the disk has no room for the file', async () => {
    const { deps, steps } = fakeDeps({ freeSpace: async () => ({ available: 2e9, headroom: 1e9 }) })

    await expect(installLiteRtLmVariant({ model: curated, variant: gpu }, deps)).rejects.toBeInstanceOf(
      InsufficientModelSpaceError
    )
    expect(steps).toEqual(['check variant'])
  })

  it('does not fetch a file already complete on disk, and checks and records it', async () => {
    const { deps, steps } = fakeDeps({ existingSize: async () => 3_650_000_000 })

    await installLiteRtLmVariant({ model: curated, variant: gpu }, deps)

    expect(steps).toEqual(['check variant', 'check file', 'model.yml'])
  })
})
