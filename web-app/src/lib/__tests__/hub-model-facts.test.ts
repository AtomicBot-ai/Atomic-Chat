import { describe, expect, it } from 'vitest'
import { hubEngine, modelEngineIds } from '@/lib/hub-model-engines'
import {
  hubModelFacts,
  hubModelName,
  hubRepoId,
  hubSortValue,
} from '@/lib/hub-model-facts'
import { hubEngineLabel } from '@/lib/hub-model-engines'
import type { CatalogModel } from '@/services/models/types'

const GB = 1024 ** 3

const gguf = (
  name: string,
  size = '4.00 GB',
  extra: Partial<CatalogModel> = {}
) =>
  ({
    model_name: name,
    developer: name.split('/')[0],
    downloads: 1,
    num_quants: 1,
    quants: [{ model_id: `${name}-Q4_K_M`, path: 'q4.gguf', file_size: size }],
    ...extra,
  }) as CatalogModel

const managed = (parameters: Record<string, number>, curatedBy?: string) =>
  ({
    model_name: 'Qwen/Qwen3-8B-FP8',
    developer: 'Qwen',
    downloads: 1,
    is_managed: true,
    managed: { architectures: ['Qwen3ForCausalLM'], parameters, curatedBy },
  }) as CatalogModel

const foundry = {
  model_name: 'foundry-local/phi-4-mini',
  description: '',
  downloads: 0,
  is_foundry_local: true,
  foundry_local: {
    origin: 'curated',
    model_id: 'phi-4-mini',
    name: 'Phi-4 mini',
    summary: '',
    context_length: 131072,
    variants: [],
  },
} as unknown as CatalogModel

describe('modelEngineIds', () => {
  it('runs a GGUF on either llama.cpp', () => {
    expect(modelEngineIds(gguf('unsloth/Qwen3-8B-GGUF'))).toEqual([
      'llamacpp-upstream',
      'llamacpp',
    ])
  })

  it("runs Bonsai's packing on PrismML only, by name, by quant, or under its own format", () => {
    expect(modelEngineIds(gguf('prism-ml/Bonsai-8B-gguf'))).toEqual([
      'atomic-prism',
    ])
    expect(
      modelEngineIds(
        gguf('someone/ternary-GGUF', '1 GB', {
          quants: [
            { model_id: 'ternary-PQ2_0', path: 'x.gguf', file_size: '1 GB' },
          ],
        })
      )
    ).toEqual(['atomic-prism'])
    expect(
      modelEngineIds(gguf('someone/anything-GGUF'), 'atomic-prism')
    ).toEqual(['atomic-prism'])
  })

  it('runs MLX weights on MLX', () => {
    expect(
      modelEngineIds({
        model_name: 'mlx-community/Qwen3-8B-4bit',
        is_mlx: true,
        downloads: 0,
      } as CatalogModel)
    ).toEqual(['mlx'])
  })

  it('reads a managed checkpoint as the managed format shown, else as its curator', () => {
    expect(modelEngineIds(managed({}), 'sglang')).toEqual(['sglang'])
    expect(modelEngineIds(managed({}, 'vllm'), 'gguf')).toEqual(['vllm'])
    expect(modelEngineIds(managed({}))).toEqual([])
  })

  it('runs a Foundry Local model on Foundry Local', () => {
    expect(modelEngineIds(foundry)).toEqual(['foundry-local'])
    expect(hubEngine('foundry-local')?.format).toBe('foundry-local')
    expect(hubEngine('sglang')?.format).toBe('sglang')
  })

  it('names engines as the rest of the app does', () => {
    expect(hubEngineLabel('llamacpp-upstream')).toBe('llama.cpp')
    expect(hubEngineLabel('llamacpp')).toBe('llama.cpp turboquant')
    expect(hubEngineLabel('tensorrt-llm')).toBe('TensorRT-LLM')
  })
})

describe('hubModelFacts', () => {
  it('judges the fit of the download as the download card does', () => {
    // estimateFit: up to 70% of the budget fits well, up to all of it might.
    const budget = 10 * GB
    expect(
      hubModelFacts(gguf('a/small-GGUF', '7.00 GB'), { budgetBytes: budget })
    ).toMatchObject({
      sizeText: expect.stringMatching(/^7(\.0+)? GB$/),
      sizeBytes: 7 * GB,
      fit: 'ok',
    })
    expect(
      hubModelFacts(gguf('a/mid-GGUF', '7.10 GB'), { budgetBytes: budget }).fit
    ).toBe('maybe')
    expect(
      hubModelFacts(gguf('a/big-GGUF', '11.00 GB'), { budgetBytes: budget }).fit
    ).toBe('no')
  })

  it('leaves the fit unknown without a size or a memory reading', () => {
    expect(
      hubModelFacts(gguf('a/x-GGUF', '4.00 GB', { quants: [] }), {
        budgetBytes: 10 * GB,
      })
    ).toMatchObject({ sizeText: undefined, fit: undefined })
    expect(
      hubModelFacts(gguf('a/x-GGUF'), { budgetBytes: 0 }).fit
    ).toBeUndefined()
  })

  it("sizes a managed checkpoint from its parameters and leaves its fit to the engine's check", () => {
    const facts = hubModelFacts(managed({ BF16: 4e9, F32: 1e8 }), {
      format: 'vllm',
      budgetBytes: 64 * GB,
    })
    expect(facts).toMatchObject({
      params: '4.1B',
      format: 'vllm',
      sizeBytes: 4e9 * 2 + 1e8 * 4,
      fit: undefined,
      engines: ['vllm'],
    })
  })

  it('leaves the size and fit of a Foundry Local model to its variants', () => {
    expect(
      hubModelFacts(foundry, { format: 'foundry-local', budgetBytes: 64 * GB })
    ).toMatchObject({
      format: 'foundry-local',
      sizeText: undefined,
      fit: undefined,
      engines: ['foundry-local'],
    })
  })

  it('takes the curated capabilities of a pick over the heuristics', () => {
    const facts = hubModelFacts(gguf('a/vision-GGUF'), {
      budgetBytes: 0,
      categories: ['vision', 'tools'],
    })
    expect(facts.capabilities.map((cap) => cap.label)).toEqual([
      'Vision',
      'Tool Use',
    ])
  })
})

describe('hubSortValue', () => {
  const value = (
    model: CatalogModel,
    column: Parameters<typeof hubSortValue>[2]
  ) =>
    hubSortValue(
      hubModelName(model),
      hubModelFacts(model, { budgetBytes: 0 }),
      column,
      hubEngineLabel
    )

  it('compares parameters as numbers, unknown as undefined', () => {
    expect(value(gguf('a/Model-1.5B-GGUF'), 'parameters')).toBe(1.5e9)
    expect(value(gguf('a/Model-GGUF'), 'parameters')).toBeUndefined()
  })

  it('compares the download by bytes, unknown as undefined', () => {
    expect(value(gguf('a/x-GGUF', '512 MB'), 'downloadSize')).toBe(
      512 * 1024 ** 2
    )
    expect(value(gguf('a/x-GGUF', '2.00 GB'), 'downloadSize')).toBe(2 * GB)
    expect(
      value(gguf('a/Model-GGUF', '4.00 GB', { quants: [] }), 'downloadSize')
    ).toBeUndefined()
  })
})

describe('names', () => {
  it('shows a pick title or a Foundry name over the repo, and keeps the repo id for links', () => {
    expect(
      hubModelName(gguf('a/Qwen3-GGUF'), {
        model_name: 'a/Qwen3-GGUF',
        title: 'Qwen 3',
      })
    ).toBe('Qwen 3')
    expect(hubModelName(foundry)).toBe('Phi-4 mini')
    expect(hubModelName(gguf('a/Qwen3-GGUF'))).toBe('Qwen3-GGUF')
    expect(hubRepoId(gguf('a/Qwen3-GGUF'))).toBe('a/Qwen3-GGUF')
    expect(
      hubRepoId({
        model_name: 'Qwen3-GGUF',
        developer: 'a',
        downloads: 0,
      } as CatalogModel)
    ).toBe('a/Qwen3-GGUF')
  })
})
