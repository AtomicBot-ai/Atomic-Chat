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
