import { describe, expect, it } from 'vitest'
import { DefaultModelsService } from '@/services/models/default'
import type { HuggingFaceRepo } from '@/services/models/types'

describe('DefaultModelsService Hugging Face conversion', () => {
  const service = new DefaultModelsService()
  const repo: HuggingFaceRepo = {
    id: 'acme/vision-model',
    modelId: 'acme/vision-model',
    sha: 'abc123',
    downloads: 42,
    likes: 7,
    tags: ['gguf', 'vision'],
    pipeline_tag: 'text-generation',
    createdAt: '2026-01-01T00:00:00Z',
    last_modified: '2026-01-02T00:00:00Z',
    private: false,
    disabled: false,
    gated: false,
    author: 'acme',
    siblings: [
      {
        rfilename: 'vision-model.Q4_K_M.GGUF',
        size: 2 * 1024 ** 3,
        blobId: 'model',
      },
      {
        rfilename: 'mmproj-vision-model-f16.gguf',
        size: 512 * 1024 ** 2,
        blobId: 'mmproj',
      },
      {
        rfilename: 'vision-model-MTP.gguf',
        size: 256 * 1024 ** 2,
        blobId: 'mtp',
      },
      {
        rfilename: 'README.md',
        size: 1024,
        blobId: 'readme',
      },
    ],
  }

  it('builds downloadable model and mmproj entries from repository files', () => {
    const result = service.convertHfRepoToCatalogModel(repo)

    expect(result).toMatchObject({
      model_name: 'acme/vision-model',
      developer: 'acme',
      downloads: 42,
      description: '**Tags**: gguf, vision',
      num_quants: 1,
      num_mmproj: 1,
      readme: 'https://huggingface.co/acme/vision-model/resolve/main/README.md',
    })
    expect(result.quants).toEqual([
      {
        model_id: 'acme/vision-model_Q4_K_M',
        path: 'https://huggingface.co/acme/vision-model/resolve/main/vision-model.Q4_K_M.GGUF',
        file_size: '2.0 GB',
      },
    ])
    expect(result.mmproj_models).toEqual([
      {
        model_id: 'mmproj-vision-model-f16',
        path: 'https://huggingface.co/acme/vision-model/resolve/main/mmproj-vision-model-f16.gguf',
        file_size: '512.0 MB',
      },
    ])
  })

  it('excludes non-model and MTP companion files from downloadable quants', () => {
    const result = service.convertHfRepoToCatalogModel(repo)

    expect(result.quants).toHaveLength(1)
    expect(result.quants[0].path).not.toContain('MTP')
    expect(result.quants[0].path).not.toContain('README')
  })

  describe('sharded quants', () => {
    // Shape taken from unsloth/DeepSeek-V4-Flash-GGUF: quants live in folders
    // and open with a few-megabyte header shard.
    const shardedRepo: HuggingFaceRepo = {
      ...repo,
      id: 'unsloth/big-moe-GGUF',
      modelId: 'unsloth/big-moe-GGUF',
      author: 'unsloth',
      siblings: [
        {
          rfilename: 'UD-IQ4_XS/big-moe-UD-IQ4_XS-00001-of-00003.gguf',
          size: 5 * 1024 ** 2,
          blobId: 'xs-1',
        },
        {
          rfilename: 'UD-IQ4_XS/big-moe-UD-IQ4_XS-00002-of-00003.gguf',
          size: 40 * 1024 ** 3,
          blobId: 'xs-2',
        },
        {
          rfilename: 'UD-IQ4_XS/big-moe-UD-IQ4_XS-00003-of-00003.gguf',
          size: 20 * 1024 ** 3,
          blobId: 'xs-3',
        },
        {
          rfilename: 'UD-Q2_K_XL/big-moe-UD-Q2_K_XL-00001-of-00002.gguf',
          size: 5 * 1024 ** 2,
          blobId: 'q2-1',
        },
        {
          rfilename: 'UD-Q2_K_XL/big-moe-UD-Q2_K_XL-00002-of-00002.gguf',
          size: 30 * 1024 ** 3,
          blobId: 'q2-2',
        },
      ],
    }

    it('offers one variant per quant instead of one per shard', () => {
      const result = service.convertHfRepoToCatalogModel(shardedRepo)

      expect(result.num_quants).toBe(2)
      expect(result.quants.map((quant) => quant.model_id)).toEqual([
        'unsloth/UD-IQ4_XS/big-moe-UD-IQ4_XS',
        'unsloth/UD-Q2_K_XL/big-moe-UD-Q2_K_XL',
      ])
    })

    it('quotes the whole shard set, not its header file', () => {
      const result = service.convertHfRepoToCatalogModel(shardedRepo)

      // 5 MB + 40 GB + 20 GB, rounded the way the catalog formats sizes.
      expect(result.quants[0].file_size).toBe('60.0 GB')
      expect(result.quants[1].file_size).toBe('30.0 GB')
    })

    it('points the download at the first shard', () => {
      const result = service.convertHfRepoToCatalogModel(shardedRepo)

      expect(result.quants[0].path).toBe(
        'https://huggingface.co/unsloth/big-moe-GGUF/resolve/main/UD-IQ4_XS/big-moe-UD-IQ4_XS-00001-of-00003.gguf'
      )
    })
  })

  it('returns empty download collections when repository files are absent', () => {
    const result = service.convertHfRepoToCatalogModel({
      ...repo,
      siblings: undefined,
    })

    expect(result).toMatchObject({
      num_quants: 0,
      quants: [],
      num_mmproj: 0,
      mmproj_models: [],
      num_safetensors: 0,
      safetensors_files: [],
    })
  })
})
