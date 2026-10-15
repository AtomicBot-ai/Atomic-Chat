import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { describe, expect, it, vi } from 'vitest'

import resolved from './fixtures/resolve-qwen3-0.6b-generic-gpu.json'
import {
  FoundryLocalNotReadyError,
  FoundryLocalSourceUnavailableError,
  installFoundryLocalVariant,
  type FoundryLocalInstallDeps,
} from '../install'
import { foundryLocalDownloadId } from '@/lib/foundry-local/download-id'
import type { FoundryLocalList } from '../curated'
import type { FoundryLocalHubModel, FoundryLocalHubVariant } from '../types'
import type { TransferItem } from '@/services/diffusion/transfer'

const LISTING = readFileSync(join(__dirname, 'fixtures', 'listing-qwen3-0.6b-generic-gpu.xml'), 'utf8')
const SAS = resolved.blobSasUri
const [CONTAINER, QUERY] = SAS.split('?')

const list: FoundryLocalList = {
  schema_version: 1,
  updated_at: '2026-10-15T00:00:00Z',
  resolver: {
    url_template:
      'https://{region}.api.azureml.ms/modelregistry/v1.0/registry/models/nonazureaccount?assetId={asset_id}',
    regions: ['eastus', 'westeurope'],
  },
  catalog: { url: 'https://api.catalog.azureml.ms/asset-gallery/v1.0/models' },
  models: [],
}

const ASSET = 'azureml://registries/azureml/models/qwen3-0.6b-generic-gpu/versions/2'

const catalogVariant: FoundryLocalHubVariant = {
  id: 'qwen3-0.6b-generic-gpu',
  device: 'gpu',
  execution_provider: 'webgpu',
  platforms: ['win-x64', 'win-arm64', 'macos-arm64'],
  asset_id: ASSET,
  version: '2',
  size_bytes: 554796483,
}
const catalogModel: FoundryLocalHubModel = {
  origin: 'microsoft',
  model_id: 'qwen3-0.6b',
  name: 'qwen3-0.6b',
  summary: 'apache-2.0',
  license: 'apache-2.0',
  variants: [catalogVariant],
}

const SHA = (c: string) => c.repeat(64)
const curatedVariant: FoundryLocalHubVariant = {
  ...catalogVariant,
  context_length: 4096,
  path_prefix: 'v2',
  files: [
    { path: 'genai_config.json', size: 1752, sha256: SHA('a') },
    { path: 'model.onnx', size: 543321042, sha256: SHA('b') },
  ],
}
const curatedModel: FoundryLocalHubModel = {
  origin: 'curated',
  model_id: 'qwen3-0.6b',
  name: 'Qwen3 0.6B',
  summary: 'Curated',
  license: 'apache-2.0',
  context_length: 40960,
  tools: true,
  reasoning: true,
  variants: [curatedVariant],
}

type Step = string

function fakeDeps(overrides: Partial<FoundryLocalInstallDeps> = {}) {
  const steps: Step[] = []
  const transfers: TransferItem[][] = []
  const yaml: Array<{ path: string; data: Record<string, unknown> }> = []
  const deps: FoundryLocalInstallDeps = {
    check: vi.fn(async () => {
      steps.push('check')
      return { verdict: 'ok', reason: null, accelerator: 'WebGpuExecutionProvider' }
    }),
    getText: vi.fn(async (url: string) => {
      if (url.includes('api.azureml.ms')) {
        steps.push(`resolve ${new URL(url).hostname.split('.')[0]}`)
        return { status: 200, text: JSON.stringify(resolved) }
      }
      steps.push('list')
      return { status: 200, text: LISTING }
    }),
    dataFolder: async () => '/data',
    existingSize: async () => null,
    hasPartial: async () => false,
    freeSpace: async () => ({ available: 100e9, headroom: 1e9 }),
    transfer: vi.fn(async (items: TransferItem[]) => {
      steps.push('transfer')
      transfers.push(items)
    }),
    writeYaml: vi.fn(async (path: string, data: unknown) => {
      steps.push('model.yml')
      yaml.push({ path, data: data as Record<string, unknown> })
    }),
    emit: vi.fn(),
    ...overrides,
  }
  return { deps, steps, transfers, yaml }
}

describe('installFoundryLocalVariant', () => {
  it('asks the verdict, resolves, downloads every file under one task, and writes model.yml last', async () => {
    const { deps, steps, transfers, yaml } = fakeDeps()

    const result = await installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)

    expect(steps).toEqual(['check', 'resolve eastus', 'transfer', 'model.yml'])
    expect(result.modelId).toBe('qwen3-0.6b-generic-gpu')
    expect(transfers[0]).toEqual([
      {
        url: `${CONTAINER}/v2/genai_config.json?${QUERY}`,
        save_path: '/data/foundry-local/models/qwen3-0.6b-generic-gpu/genai_config.json',
        size: 1752,
        sha256: SHA('a'),
        model_id: 'foundry-local-qwen3-0_6b-generic-gpu',
        resume_key: 'foundry-local/qwen3-0.6b-generic-gpu/genai_config.json',
      },
      {
        url: `${CONTAINER}/v2/model.onnx?${QUERY}`,
        save_path: '/data/foundry-local/models/qwen3-0.6b-generic-gpu/model.onnx',
        size: 543321042,
        sha256: SHA('b'),
        model_id: 'foundry-local-qwen3-0_6b-generic-gpu',
        resume_key: 'foundry-local/qwen3-0.6b-generic-gpu/model.onnx',
      },
    ])
    expect(vi.mocked(deps.transfer).mock.calls[0][1]).toBe(foundryLocalDownloadId('qwen3-0.6b-generic-gpu'))
    expect(yaml[0].path).toBe('/data/foundry-local/models/qwen3-0.6b-generic-gpu/model.yml')
  })

  it('writes the variant’s context, the list’s capabilities and the resolve answer’s reasoning markers', async () => {
    const { deps, yaml } = fakeDeps()

    await installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)

    expect(yaml[0].data).toEqual({
      model_path: 'foundry-local/models/qwen3-0.6b-generic-gpu',
      name: 'Qwen3 0.6B (WebGPU)',
      size_bytes: 1752 + 543321042,
      foundry_local: {
        model_id: 'qwen3-0.6b',
        variant_id: 'qwen3-0.6b-generic-gpu',
        execution_provider: 'webgpu',
        device: 'gpu',
        asset_id: ASSET,
        asset_version: '2',
        context_length: 4096,
        tools: true,
        reasoning: true,
        reasoning_start: '<think>',
        reasoning_end: '</think>',
      },
    })
  })

  it('builds a catalog variant’s files from the container listing, checked by size only', async () => {
    const { deps, steps, transfers, yaml } = fakeDeps()

    await installFoundryLocalVariant({ model: catalogModel, variant: catalogVariant, list }, deps)

    expect(steps).toEqual(['check', 'resolve eastus', 'list', 'transfer', 'model.yml'])
    const listingUrl = vi.mocked(deps.getText).mock.calls[1][0]
    expect(listingUrl).toBe(`${SAS}&restype=container&comp=list&prefix=${encodeURIComponent('v2/')}`)
    expect(transfers[0].map((item) => [item.save_path.split('/').pop(), item.size, item.sha256])).toEqual([
      ['chat_template.jinja', 4168, undefined],
      ['config.json', 9033, undefined],
      ['genai_config.json', 1752, undefined],
      ['model.onnx', 543321042, undefined],
      ['model_config.json', 37177, undefined],
      ['tokenizer.json', 11422647, undefined],
      ['tokenizer_config.json', 663, undefined],
    ])
    expect(transfers[0][3].url).toBe(`${CONTAINER}/v2/model.onnx?${QUERY}`)
    // The catalog has no metadata: the resolve answer's kvTags give it.
    expect(yaml[0].data.foundry_local).toMatchObject({ context_length: 40960, tools: true, reasoning: true })
  })

  it('resolves again on an expired link and downloads on, under the same keys', async () => {
    let transfers = 0
    const { deps, steps } = fakeDeps({
      transfer: vi.fn(async () => {
        transfers += 1
        steps.push('transfer')
        if (transfers === 1) {
          throw new Error('Failed to resume download: HTTP status 403 Forbidden, <Error><Code>AuthenticationFailed</Code></Error>')
        }
      }),
    })

    await installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)

    expect(steps).toEqual(['check', 'resolve eastus', 'transfer', 'resolve eastus', 'transfer', 'model.yml'])
    const [first, second] = vi.mocked(deps.transfer).mock.calls.map((call) => call[0])
    expect(second.map((item) => item.resume_key)).toEqual(first.map((item) => item.resume_key))
    expect(vi.mocked(deps.transfer).mock.calls[1][2]).toMatchObject({ resume: true })
  })

  it('tries the next region when one does not answer', async () => {
    const { deps, steps } = fakeDeps({
      getText: vi.fn(async (url: string) => {
        const region = new URL(url).hostname.split('.')[0]
        steps.push(`resolve ${region}`)
        if (region === 'eastus') return { status: 503, text: 'Service Unavailable' }
        return { status: 200, text: JSON.stringify(resolved) }
      }),
    })

    await installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)

    expect(steps.slice(0, 3)).toEqual(['check', 'resolve eastus', 'resolve westeurope'])
  })

  it('says the Foundry Local source is unavailable when no region gives a link, and downloads nothing', async () => {
    const { deps } = fakeDeps({
      getText: vi.fn(async () => ({ status: 200, text: JSON.stringify({ modelEntity: {} }) })),
    })

    await expect(
      installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)
    ).rejects.toBeInstanceOf(FoundryLocalSourceUnavailableError)
    expect(deps.transfer).not.toHaveBeenCalled()
    expect(deps.writeYaml).not.toHaveBeenCalled()
  })

  it('does not write model.yml when a curated file fails its sha256', async () => {
    const { deps } = fakeDeps({
      transfer: vi.fn(async () => {
        throw new Error('Hash verification failed for model.onnx')
      }),
    })

    await expect(
      installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)
    ).rejects.toThrow('Hash verification failed')
    expect(deps.writeYaml).not.toHaveBeenCalled()
  })

  it('does not write model.yml when a catalog file is shorter than the listing says', async () => {
    const { deps } = fakeDeps({
      transfer: vi.fn(async () => {
        throw new Error('Size verification failed for model.onnx: expected 543321042, got 1000')
      }),
    })

    await expect(
      installFoundryLocalVariant({ model: catalogModel, variant: catalogVariant, list }, deps)
    ).rejects.toThrow('Size verification failed')
    expect(deps.writeYaml).not.toHaveBeenCalled()
  })

  it('downloads nothing for a variant the core does not accept', async () => {
    const { deps } = fakeDeps({
      check: vi.fn(async () => ({
        verdict: 'accelerator-not-prepared' as const,
        reason: 'WebGpuExecutionProvider is not prepared yet.',
        accelerator: 'WebGpuExecutionProvider',
      })),
    })

    await expect(
      installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)
    ).rejects.toBeInstanceOf(FoundryLocalNotReadyError)
    expect(deps.getText).not.toHaveBeenCalled()
  })

  it('skips files already complete on disk and refuses a download the drive cannot hold', async () => {
    const { deps } = fakeDeps({
      existingSize: async (path: string) => (path.endsWith('genai_config.json') ? 1752 : null),
      freeSpace: async () => ({ available: 100e6, headroom: 1e6 }),
    })

    await expect(
      installFoundryLocalVariant({ model: curatedModel, variant: curatedVariant, list }, deps)
    ).rejects.toThrow(/free space/i)
    expect(deps.transfer).not.toHaveBeenCalled()
  })
})
