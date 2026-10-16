import { beforeEach, describe, expect, it, vi } from 'vitest'

import recorded from './fixtures/microsoft-catalog.json'
import {
  fetchMicrosoftCatalog,
  resetMicrosoftCatalogForTests,
  type CatalogPost,
} from '../microsoft-catalog'
import type { FoundryLocalModel } from '../curated'

const URL = 'https://api.catalog.azureml.ms/asset-gallery/v1.0/models'

/** Answers the recorded pages in order, by continuation token. */
function recordedCatalog() {
  const bodies: Record<string, unknown>[] = []
  const post: CatalogPost = async (url, body) => {
    expect(url).toBe(URL)
    bodies.push(body)
    const token = body.continuationToken
    return token === 'page-2' ? recorded.pages[1] : recorded.pages[0]
  }
  return { post, bodies }
}

const curatedQwen: FoundryLocalModel = {
  id: 'qwen2.5-7b-instruct',
  name: 'Qwen2.5 7B Instruct',
  description: 'Curated',
  task: 'chat',
  license: 'apache-2.0',
  context_length: 32768,
  tools: true,
  reasoning: false,
  variants: [
    {
      id: 'qwen2.5-7b-instruct-openvino-npu',
      device: 'npu',
      execution_provider: 'openvino',
      platforms: ['win-x64'],
      source: {
        kind: 'azureml',
        asset_id: 'azureml://registries/azureml/models/qwen2.5-7b-instruct-openvino-npu/versions/4',
        version: '4',
        path_prefix: 'v4',
      },
      files: [{ path: 'model.onnx', size: 1, sha256: 'a'.repeat(64) }],
      context_length: 4096,
    },
  ],
}

beforeEach(() => resetMicrosoftCatalogForTests())

describe('fetchMicrosoftCatalog (recorded answers)', () => {
  it('asks for the latest variants on the supported accelerators, page by page', async () => {
    const { post, bodies } = recordedCatalog()

    await fetchMicrosoftCatalog({ url: URL, curated: [], post })

    expect(bodies).toHaveLength(2)
    expect(bodies[0].filters).toEqual([
      { field: 'labels', operator: 'eq', values: ['latest'] },
      {
        field: 'VariantInformation/VariantMetadata/ExecutionProvider',
        operator: 'eq',
        values: [
          'CPUExecutionProvider',
          'CUDAExecutionProvider',
          'WebGPUExecutionProvider',
          'OpenVINOExecutionProvider',
          'QNNExecutionProvider',
          'VitisAIExecutionProvider',
        ],
      },
    ])
    expect(bodies[0].continuationToken).toBeUndefined()
    expect(bodies[1].continuationToken).toBe('page-2')
  })

  it('groups the variants of each chat model under its parent model', async () => {
    const { post } = recordedCatalog()

    const result = await fetchMicrosoftCatalog({ url: URL, curated: [], post })

    expect(result.unavailable).toBe(false)
    // In the order the catalog listed them.
    expect(result.models.map((model) => model.id)).toEqual([
      'mistral-nemo-12b-instruct',
      'olmo-3-7b-instruct',
      'qwen2.5-7b-instruct',
    ])
    const olmo = result.models[1]
    expect(olmo.license).toBe('apache-2.0')
    expect(olmo.variants.map((variant) => [variant.id, variant.execution_provider, variant.device])).toEqual([
      ['olmo-3-7b-instruct-generic-gpu', 'webgpu', 'gpu'],
      ['olmo-3-7b-instruct-generic-cpu', 'cpu', 'cpu'],
      ['olmo-3-7b-instruct-cuda-gpu', 'cuda', 'gpu'],
    ])
    expect(olmo.variants[0]).toMatchObject({
      asset_id: 'azureml://registries/azureml/models/olmo-3-7b-instruct-generic-gpu/versions/1',
      version: '1',
      platforms: ['win-x64', 'win-arm64', 'macos-arm64'],
    })
    expect(olmo.variants[0].size_bytes).toBeGreaterThan(0)
  })

  it('leaves out speech and embedding models and the TensorRT-RTX variants', async () => {
    const { post } = recordedCatalog()

    const result = await fetchMicrosoftCatalog({ url: URL, curated: [], post })

    const ids = result.models.flatMap((model) => model.variants.map((variant) => variant.id))
    expect(ids.some((id) => id.includes('whisper'))).toBe(false)
    expect(ids.some((id) => id.includes('embedding'))).toBe(false)
    expect(ids.some((id) => id.includes('trtrtx'))).toBe(false)
    expect(result.models.find((model) => model.id === 'qwen2.5-7b-instruct')?.variants).toHaveLength(7)
  })

  it('drops a variant the curated list has with the same asset id and version', async () => {
    const { post } = recordedCatalog()

    const result = await fetchMicrosoftCatalog({ url: URL, curated: [curatedQwen], post })

    const qwen = result.models.find((model) => model.id === 'qwen2.5-7b-instruct')
    expect(qwen?.variants.map((variant) => variant.id)).not.toContain('qwen2.5-7b-instruct-openvino-npu')
    expect(qwen?.variants).toHaveLength(6)
  })

  it('reports the catalog unavailable, with nothing in it, when the network fails', async () => {
    const result = await fetchMicrosoftCatalog({
      url: URL,
      curated: [],
      post: async () => {
        throw new Error('getaddrinfo ENOTFOUND api.catalog.azureml.ms')
      },
    })

    expect(result).toMatchObject({ models: [], unavailable: true })
    expect(result.error).toContain('ENOTFOUND')
  })

  it('reports the catalog unavailable when it answers something else', async () => {
    const result = await fetchMicrosoftCatalog({ url: URL, curated: [], post: async () => ({ items: [] }) })

    expect(result).toMatchObject({ models: [], unavailable: true })
  })

  it('asks once per Hub session', async () => {
    const { post, bodies } = recordedCatalog()

    await fetchMicrosoftCatalog({ url: URL, curated: [], post })
    const again = await fetchMicrosoftCatalog({ url: URL, curated: [], post })

    expect(bodies).toHaveLength(2)
    expect(again.models).toHaveLength(3)
  })

  it('asks again after a failure', async () => {
    const failing = vi.fn(async () => {
      throw new Error('offline')
    })
    await fetchMicrosoftCatalog({ url: URL, curated: [], post: failing })
    const { post } = recordedCatalog()

    const result = await fetchMicrosoftCatalog({ url: URL, curated: [], post })

    expect(result.unavailable).toBe(false)
  })
})
