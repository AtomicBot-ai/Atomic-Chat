import { describe, expect, it } from 'vitest'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import type { CatalogModel } from '@/services/models/types'
import {
  collectInstalledModels,
  filterInstalledBySearch,
  findInstalledLocalModel,
  LLAMACPP_PROVIDERS,
  mlxModelIds,
  quantModelIds,
} from '../hub-installed'

const gguf = (
  name: string,
  quantIds: string[],
  extra: Partial<CatalogModel> = {}
): CatalogModel => ({
  model_name: name,
  description: '',
  downloads: 0,
  developer: name.split('/')[0],
  is_mlx: false,
  quants: quantIds.map((id) => ({
    model_id: id,
    path: `https://huggingface.co/${name}/resolve/main/${id}.gguf`,
    file_size: '4.0 GB',
  })),
  ...extra,
})

const mlx = (
  name: string,
  extra: Partial<CatalogModel> = {}
): CatalogModel => ({
  model_name: name,
  description: '',
  downloads: 0,
  developer: name.split('/')[0],
  is_mlx: true,
  library_name: 'mlx',
  ...extra,
})

const provider = (name: string, ids: string[]): ModelProvider =>
  ({
    active: true,
    provider: name,
    settings: [],
    models: ids.map((id) => ({ id })),
  }) as ModelProvider

describe('collectInstalledModels', () => {
  it('returns nothing when no local provider carries a model', () => {
    const catalog = [gguf('unsloth/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M'])]
    expect(collectInstalledModels(catalog, [provider('llamacpp', [])])).toEqual(
      []
    )
  })

  it('prefers the catalog entry when it claims the installed id', () => {
    const entry = gguf('unsloth/Qwen3-4B-GGUF', [
      'Qwen3-4B-Q4_K_M',
      'Qwen3-4B-Q8_0',
    ])
    const rows = collectInstalledModels(
      [entry],
      [provider('llamacpp', ['Qwen3-4B-Q4_K_M'])]
    )
    expect(rows).toEqual([entry])
  })

  it('matches a developer-prefixed id registered by the upstream provider', () => {
    const entry = gguf('unsloth/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M'])
    const rows = collectInstalledModels(
      [entry],
      [provider('llamacpp-upstream', ['unsloth/Qwen3-4B-Q4_K_M'])]
    )
    expect(rows).toEqual([entry])
  })

  it('matches an MLX repo through the engine-specific id sanitizer', () => {
    const entry = mlx('mlx-community/Qwen3-4B-4bit')
    const rows = collectInstalledModels(
      [entry],
      [provider('mlx', ['Qwen3-4B-4bit'])]
    )
    expect(rows).toEqual([entry])
  })

  it('synthesizes a row for an installed model the catalog does not carry', () => {
    const rows = collectInstalledModels(
      [gguf('unsloth/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M'])],
      [provider('llamacpp', ['TheBloke/some-local-model-Q5_K_M'])]
    )

    expect(rows).toHaveLength(1)
    expect(rows[0]).toMatchObject({
      model_name: 'TheBloke/some-local-model-Q5_K_M',
      developer: 'TheBloke',
      is_mlx: false,
      quants: [{ model_id: 'TheBloke/some-local-model-Q5_K_M' }],
    })
  })

  it('carries the installed weights path into the synthesized quant', () => {
    const providers = [
      {
        active: true,
        provider: 'llamacpp',
        settings: [],
        models: [{ id: 'imported-model', path: '/models/imported-model.gguf' }],
      },
    ] as ModelProvider[]

    const rows = collectInstalledModels([], providers)
    expect(rows[0].quants?.[0].path).toBe('/models/imported-model.gguf')
  })

  it('synthesizes an MLX row without a quant list', () => {
    const rows = collectInstalledModels([], [provider('mlx', ['local-4bit'])])
    expect(rows[0]).toMatchObject({
      model_name: 'local-4bit',
      is_mlx: true,
      developer: undefined,
    })
    expect(rows[0].quants).toBeUndefined()
  })

  it('lists an id registered by both llama.cpp providers once', () => {
    const rows = collectInstalledModels(
      [],
      [
        provider('llamacpp', ['shared-model']),
        provider('llamacpp-upstream', ['shared-model']),
      ]
    )
    expect(rows).toHaveLength(1)
  })

  it('skips embedding models, which cannot serve a chat', () => {
    const providers = [
      {
        active: true,
        provider: 'llamacpp',
        settings: [],
        models: [
          { id: EMBEDDING_MODEL_ID },
          { id: 'bge-small', embedding: true },
          { id: 'chat-model' },
        ],
      },
    ] as ModelProvider[]

    const rows = collectInstalledModels([], providers)
    expect(rows.map((row) => row.model_name)).toEqual(['chat-model'])
  })

  it('ignores models registered by remote providers', () => {
    const rows = collectInstalledModels([], [provider('openai', ['gpt-4o'])])
    expect(rows).toEqual([])
  })
})

describe('filterInstalledBySearch', () => {
  const rows = [
    gguf('unsloth/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M']),
    mlx('mlx-community/gemma-4-12B-it-4bit'),
  ]

  it('keeps every row for an empty query', () => {
    expect(filterInstalledBySearch(rows, '   ')).toHaveLength(2)
  })

  it('matches the id and the developer case-insensitively', () => {
    expect(
      filterInstalledBySearch(rows, 'GEMMA').map((row) => row.model_name)
    ).toEqual(['mlx-community/gemma-4-12B-it-4bit'])
    expect(
      filterInstalledBySearch(rows, 'unsloth').map((row) => row.model_name)
    ).toEqual(['unsloth/Qwen3-4B-GGUF'])
  })
})

describe('findInstalledLocalModel', () => {
  const entry = gguf('unsloth/Qwen3-4B-GGUF', ['Qwen3-4B-Q4_K_M'])

  it('reports the provider that registered the quant', () => {
    expect(
      findInstalledLocalModel(
        [provider('llamacpp-upstream', ['Qwen3-4B-Q4_K_M'])],
        quantModelIds(entry, 'Qwen3-4B-Q4_K_M')
      )
    ).toEqual({ modelId: 'Qwen3-4B-Q4_K_M', provider: 'llamacpp-upstream' })
  })

  it('reports the id the engine actually registered, not the catalog spelling', () => {
    expect(
      findInstalledLocalModel(
        [provider('llamacpp', ['unsloth/Qwen3-4B-Q4_K_M'])],
        quantModelIds(entry, 'Qwen3-4B-Q4_K_M')
      )
    ).toEqual({ modelId: 'unsloth/Qwen3-4B-Q4_K_M', provider: 'llamacpp' })
  })

  it('resolves an id both llama.cpp providers registered to the upstream one', () => {
    // Shared models dir: both engines list the same file. The default engine
    // (upstream) must answer, not the TurboQuant fork.
    expect(
      findInstalledLocalModel(
        [
          provider('llamacpp', ['Qwen3-4B-Q4_K_M']),
          provider('llamacpp-upstream', ['Qwen3-4B-Q4_K_M']),
        ],
        quantModelIds(entry, 'Qwen3-4B-Q4_K_M')
      )
    ).toEqual({ modelId: 'Qwen3-4B-Q4_K_M', provider: 'llamacpp-upstream' })
  })

  it('returns null when no local provider carries the id', () => {
    expect(
      findInstalledLocalModel(
        [provider('llamacpp', ['Qwen3-4B-Q8_0'])],
        quantModelIds(entry, 'Qwen3-4B-Q4_K_M')
      )
    ).toBeNull()
  })

  it('honours the provider whitelist so a GGUF row never matches an MLX id', () => {
    const providers = [provider('mlx', ['Qwen3-4B-Q4_K_M'])]
    expect(
      findInstalledLocalModel(
        providers,
        quantModelIds(entry, 'Qwen3-4B-Q4_K_M'),
        LLAMACPP_PROVIDERS
      )
    ).toBeNull()
  })

  it('finds an MLX repo under the engine-specific id', () => {
    expect(
      findInstalledLocalModel(
        [provider('mlx', ['mlx-community/Qwen3-4B-4bit'])],
        mlxModelIds(mlx('mlx-community/Qwen3-4B-4bit'))
      )
    ).toEqual({
      modelId: 'mlx-community/Qwen3-4B-4bit',
      provider: 'mlx',
    })
  })
})
