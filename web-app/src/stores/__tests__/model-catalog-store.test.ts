import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CatalogModel } from '@/services/models/types'

// Shape of a published catalog entry for a sharded repo (unsloth MoE builds):
// one entry per shard, opening with a few-megabyte header.
const shardedEntry = (): CatalogModel =>
  ({
    model_name: 'unsloth/big-moe-GGUF',
    description: '',
    developer: 'unsloth',
    downloads: 1,
    num_quants: 3,
    quants: [
      {
        model_id: 'unsloth/UD-IQ4_XS/big-moe-UD-IQ4_XS-00001-of-00003',
        path: 'https://huggingface.co/unsloth/big-moe-GGUF/resolve/main/UD-IQ4_XS/big-moe-UD-IQ4_XS-00001-of-00003.gguf',
        file_size: '5.0 MB',
      },
      {
        model_id: 'unsloth/UD-IQ4_XS/big-moe-UD-IQ4_XS-00002-of-00003',
        path: 'https://huggingface.co/unsloth/big-moe-GGUF/resolve/main/UD-IQ4_XS/big-moe-UD-IQ4_XS-00002-of-00003.gguf',
        file_size: '40.0 GB',
      },
      {
        model_id: 'unsloth/UD-IQ4_XS/big-moe-UD-IQ4_XS-00003-of-00003',
        path: 'https://huggingface.co/unsloth/big-moe-GGUF/resolve/main/UD-IQ4_XS/big-moe-UD-IQ4_XS-00003-of-00003.gguf',
        file_size: '20.0 GB',
      },
    ],
    mmproj_models: [],
  }) as unknown as CatalogModel

const flatEntry = (): CatalogModel =>
  ({
    model_name: 'prism-ml/Bonsai-27B-gguf',
    description: '',
    developer: 'prism-ml',
    downloads: 1,
    num_quants: 1,
    quants: [
      {
        model_id: 'prism-ml/Bonsai-27B-Q1_0',
        path: 'https://huggingface.co/prism-ml/Bonsai-27B-gguf/resolve/main/Bonsai-27B-Q1_0.gguf',
        file_size: '3.5 GB',
      },
    ],
    mmproj_models: [],
  }) as unknown as CatalogModel

const mocks = vi.hoisted(() => ({
  remoteModels: [] as CatalogModel[],
  cachedModels: null as CatalogModel[] | null,
}))

vi.mock('@/services/model-catalog-registry', () => ({
  getBundledSeedCatalog: vi.fn(async () => null),
  getBundledSeedIndex: vi.fn(async () => null),
  getCachedIndex: vi.fn(async () => null),
  getCachedCatalog: vi.fn(async () =>
    mocks.cachedModels
      ? {
          manifest: {
            manifest_version: 1,
            schema_version: 1,
            updated_at: '2026-08-01T00:00:00Z',
            models: mocks.cachedModels,
          },
          fetchedAt: 1,
        }
      : null
  ),
  getCatalogOrFallback: vi.fn(async () => ({
    manifest: {
      manifest_version: 1,
      schema_version: 1,
      updated_at: '2026-08-07T00:00:00Z',
      models: mocks.remoteModels,
    },
    source: 'remote',
    fetchedAt: 2,
    manifestUpdatedAt: '2026-08-07T00:00:00Z',
    error: null,
  })),
  getIndexOrFallback: vi.fn(async () => ({
    payload: null,
    source: 'remote',
    fetchedAt: 2,
    error: null,
  })),
}))

// The module refreshes itself on import, so the fixtures have to be in place
// before it loads; importing later would race that first pass.
const loadStore = async () => {
  vi.resetModules()
  const { useModelCatalogStore } = await import('../model-catalog-store')
  await useModelCatalogStore.getState().refresh()
  return useModelCatalogStore
}

beforeEach(() => {
  mocks.remoteModels = []
  mocks.cachedModels = null
})

describe('model-catalog-store', () => {
  it('folds the shards of a fetched catalog into one variant per quant', async () => {
    mocks.remoteModels = [shardedEntry()]

    const store = await loadStore()

    const [model] = store.getState().catalog
    expect(model.num_quants).toBe(1)
    expect(model.quants[0]).toMatchObject({
      model_id: 'unsloth/UD-IQ4_XS/big-moe-UD-IQ4_XS',
      // 5 MB + 40 GB + 20 GB: the set, not its header file.
      file_size: '60.0 GB',
    })
  })

  it('keeps the download pointing at the first shard', async () => {
    mocks.remoteModels = [shardedEntry()]

    const store = await loadStore()

    expect(store.getState().catalog[0].quants[0].path).toContain(
      '00001-of-00003.gguf'
    )
  })

  it('leaves an unsharded entry untouched', async () => {
    mocks.remoteModels = [flatEntry()]

    const store = await loadStore()

    const [model] = store.getState().catalog
    expect(model.num_quants).toBe(1)
    expect(model.quants[0].file_size).toBe('3.5 GB')
  })
})
