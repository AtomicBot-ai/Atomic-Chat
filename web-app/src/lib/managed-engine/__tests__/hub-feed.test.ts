import { describe, expect, it } from 'vitest'

import {
  ENGINE_OVERHEAD_BYTES,
  estimateWeightBytes,
  foundryLocalRows,
  hubListSources,
  passesManagedPrefilter,
  managedBrowseRows,
  managedSearchRows,
} from '../hub-feed'
import type { GpuFacts } from '@/services/managed-environment/types'
import type { CatalogModel } from '@/services/models/types'
import { catalogHubCard, curatedHubCard } from '@/lib/foundry-local/hub'
import type { FoundryLocalModel } from '@/services/foundry-local/curated'
import type { CatalogModel as MicrosoftModel } from '@/services/foundry-local/microsoft-catalog'

const GB = 1e9

const card = (total: number | null, id = 'GPU-1'): GpuFacts => ({
  gpu_id: id,
  name: 'RTX 4090',
  compute_capability: '8.9',
  total_vram_bytes: total,
  free_vram_bytes: total,
  driver_version: '615.65.02',
})

const entry = (tensorrt: CatalogModel['managed']): CatalogModel => ({
  model_name: 'owner/model',
  description: '',
  downloads: 0,
  is_managed: true,
  managed: tensorrt,
})

const supported = ['Qwen3ForCausalLM', 'Qwen3_5ForConditionalGeneration']

describe('estimateWeightBytes', () => {
  it('counts each dtype at its width: F32 4, BF16/F16 2, F8_*/U8/I8 1, packed I32 0.5', () => {
    expect(
      estimateWeightBytes({ F32: 1, I32: 2, BF16: 1, F16: 1, F8_E4M3: 1, F8_E5M2: 1, U8: 1, I8: 1 })
    ).toBe(4 + 1 + 2 + 2 + 1 + 1 + 1 + 1)
    // NVFP4: the U8 count is already packed bytes.
    expect(estimateWeightBytes({ U8: 9 * GB, F8_E4M3: 1.1 * GB, BF16: 2 * GB })).toBe(14.1 * GB)
  })

  it('does not overcount AWQ and GPTQ: Hugging Face reports their packed I32 weights as logical parameters', () => {
    // Qwen/Qwen2.5-7B-Instruct-AWQ and -GPTQ-Int4 as the HF listing reports them; 5.57 GB on disk.
    const estimate = estimateWeightBytes({ I32: 6_525_288_448, F16: 1_090_328_064 })!
    expect(estimate).toBeLessThanOrEqual(5.57 * GB)
    expect(estimate).toBeGreaterThan(5 * GB)
    // So an 8 GB card keeps it under vLLM (weights + 2 GiB).
    const awq = entry({ architectures: ['Qwen2ForCausalLM'], parameters: { I32: 6_525_288_448, F16: 1_090_328_064 } })
    expect(
      passesManagedPrefilter(awq, {
        engineId: 'vllm',
        supportedArchitectures: ['Qwen2ForCausalLM'],
        gpus: [card(8 * 1024 ** 3)],
      })
    ).toBe(true)
  })

  it('knows nothing without parameters, and counts an unknown dtype at its narrowest', () => {
    expect(estimateWeightBytes(undefined)).toBeNull()
    expect(estimateWeightBytes({})).toBeNull()
    expect(estimateWeightBytes({ F4: 10 })).toBe(10)
  })
})

describe('passesManagedPrefilter', () => {
  it.each([
    {
      name: 'a supported architecture that fits the card',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 8 * GB } }),
      gpus: [card(24 * GB)],
      kept: true,
    },
    {
      name: 'an architecture the descriptor does not support',
      model: entry({ architectures: ['MambaForCausalLM'], parameters: { BF16: 1 * GB } }),
      gpus: [card(24 * GB)],
      kept: false,
    },
    {
      name: '140 GB of weights against a 24 GB card',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 70 * GB } }),
      gpus: [card(24 * GB)],
      kept: false,
    },
    {
      name: 'too big for one card, fits the bigger one',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 14 * GB } }),
      gpus: [card(12 * GB), card(32 * GB, 'GPU-2')],
      kept: true,
    },
    {
      name: 'weights that fit the card alone but not with the engine overhead (Ministral-3b bf16 on 8 GB)',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 3.3e9 } }),
      gpus: [card(8 * GB)],
      kept: false,
    },
    {
      name: 'a card with shared memory (no VRAM figure): size is not judged',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 70 * GB } }),
      gpus: [card(24 * GB), card(null, 'GB10')],
      kept: true,
    },
    {
      name: 'no config in the listing',
      model: entry({ parameters: { BF16: 1 * GB } }),
      gpus: [card(24 * GB)],
      kept: false,
    },
    {
      name: 'no parameters in the listing: size unknown, not judged',
      model: entry({ architectures: ['Qwen3_5ForConditionalGeneration'] }),
      gpus: [card(24 * GB)],
      kept: true,
    },
    {
      name: 'no cards known yet: size is not judged',
      model: entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 70 * GB } }),
      gpus: [],
      kept: true,
    },
  ])('$name', ({ model, gpus, kept }) => {
    expect(passesManagedPrefilter(model, { engineId: 'tensorrt-llm', supportedArchitectures: supported, gpus })).toBe(kept)
  })

  it('without the descriptor architectures, judges only what it knows', () => {
    const model = entry({ architectures: ['MambaForCausalLM'], parameters: { BF16: 1 * GB } })
    expect(passesManagedPrefilter(model, { engineId: 'tensorrt-llm', supportedArchitectures: null, gpus: [card(24 * GB)] })).toBe(
      true
    )
    expect(
      passesManagedPrefilter(entry({}), { engineId: 'tensorrt-llm', supportedArchitectures: null, gpus: [card(24 * GB)] })
    ).toBe(false)
  })
})

describe('passesManagedPrefilter by engine', () => {
  it("counts each engine's own overhead beyond the weights", () => {
    // 22 GB of weights on a 24 GB card: TensorRT-LLM's 1.5 GiB fits, vLLM's 2 GiB does not.
    const model = entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 11 * GB } })
    const gpus = [card(24 * GB)]
    expect(passesManagedPrefilter(model, { engineId: 'tensorrt-llm', supportedArchitectures: supported, gpus })).toBe(true)
    expect(passesManagedPrefilter(model, { engineId: 'vllm', supportedArchitectures: supported, gpus })).toBe(false)
  })

  it("counts SGLang's own overhead: 2 GiB, core SGLANG_ENGINE_OVERHEAD_BYTES (change add-sglang-runtime)", () => {
    expect(ENGINE_OVERHEAD_BYTES['sglang']).toBe(2 * 1024 ** 3)
    // 22 GB of weights on a 24 GB card: as for vLLM, the 2 GiB do not fit beside them.
    const model = entry({ architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 11 * GB } })
    expect(passesManagedPrefilter(model, { engineId: 'sglang', supportedArchitectures: supported, gpus: [card(24 * GB)] })).toBe(
      false
    )
  })

  it("narrows by the engine's own descriptor architectures (spec vllm-desktop 'Архитектура не поддерживается vLLM')", () => {
    const model = entry({ architectures: ['NemotronHForCausalLM'], parameters: { BF16: 1 * GB } })
    const gpus = [card(24 * GB)]
    expect(
      passesManagedPrefilter(model, { engineId: 'vllm', supportedArchitectures: ['Qwen3ForCausalLM'], gpus })
    ).toBe(false)
  })
})

describe('hubListSources', () => {
  it('GGUF and MLX: staff picks, the catalog and their own feed; TensorRT-LLM: curated and a narrowed feed', () => {
    expect(hubListSources('gguf')).toEqual({
      staffPicks: true,
      catalog: true,
      curated: false,
      feedFormat: 'gguf',
      prefilter: false,
    })
    expect(hubListSources('mlx')).toMatchObject({ staffPicks: true, catalog: true, feedFormat: 'mlx' })
    expect(hubListSources('tensorrt-llm')).toEqual({
      staffPicks: false,
      catalog: false,
      curated: true,
      feedFormat: 'safetensors',
      prefilter: true,
    })
  })

  it('vLLM lists like TensorRT-LLM: its curated models and the same narrowed safetensors feed', () => {
    expect(hubListSources('vllm')).toEqual(hubListSources('tensorrt-llm'))
  })

  it('SGLang lists like vLLM: its curated models and the same narrowed safetensors feed', () => {
    expect(hubListSources('sglang')).toEqual(hubListSources('vllm'))
  })

  it('Foundry Local: conf’s curated list, then the Microsoft catalog; no picks, no catalog, no Hugging Face', () => {
    expect(hubListSources('foundry-local')).toEqual({
      staffPicks: false,
      catalog: false,
      curated: true,
      feedFormat: 'gguf',
      prefilter: false,
    })
  })
})

describe('foundryLocalRows (change add-foundry-local)', () => {
  const curatedModel = (id: string, name: string): FoundryLocalModel => ({
    id,
    name,
    description: `${name}, checked by Atomic Chat`,
    task: 'chat',
    license: 'apache-2.0',
    context_length: 32768,
    tools: true,
    reasoning: false,
    variants: [
      {
        id: `${id}-generic-cpu`,
        device: 'cpu',
        execution_provider: 'cpu',
        platforms: ['win-x64', 'macos-arm64', 'linux-x64'],
        source: {
          kind: 'azureml',
          asset_id: `azureml://registries/azureml/models/${id}-generic-cpu/versions/1`,
          version: '1',
          path_prefix: 'v1',
        },
        files: [{ path: 'model.onnx', size: 5, sha256: 'a'.repeat(64) }],
      },
    ],
  })
  const microsoftModel = (id: string): MicrosoftModel => ({
    id,
    name: id,
    license: 'apache-2.0',
    vision: false,
    variants: [
      {
        id: `${id}-generic-gpu`,
        name: `${id}-generic-gpu`,
        asset_id: `azureml://registries/azureml/models/${id}-generic-gpu/versions/1`,
        version: '1',
        device: 'gpu',
        execution_provider: 'webgpu',
        platforms: ['win-x64', 'win-arm64', 'macos-arm64'],
        size_bytes: 4e9,
        license: 'apache-2.0',
      },
    ],
  })
  const curated = [curatedHubCard(curatedModel('qwen2.5-7b-instruct', 'Qwen2.5 7B Instruct'))]
  const catalog = [catalogHubCard(microsoftModel('olmo-3-7b-instruct')), catalogHubCard(microsoftModel('mistral-nemo-12b-instruct'))]

  const shape = (rows: ReturnType<typeof foundryLocalRows>) =>
    rows.map((row) => [row.section, row.model.foundry_local?.model_id])

  it('lists the curated models first, then the Microsoft catalog’s, marked as such', () => {
    const rows = foundryLocalRows({ curated, catalog, query: '' })
    expect(shape(rows)).toEqual([
      ['curated', 'qwen2.5-7b-instruct'],
      ['microsoft', 'olmo-3-7b-instruct'],
      ['microsoft', 'mistral-nemo-12b-instruct'],
    ])
    expect(rows.every((row) => row.model.is_foundry_local)).toBe(true)
    expect(rows[1].model.foundry_local?.origin).toBe('microsoft')
  })

  it('searches both by name (spec "Поиск по каталогу Microsoft": olmo)', () => {
    expect(shape(foundryLocalRows({ curated, catalog, query: 'OLMO' }))).toEqual([
      ['microsoft', 'olmo-3-7b-instruct'],
    ])
    expect(shape(foundryLocalRows({ curated, catalog, query: 'qwen2.5 7b' }))).toEqual([
      ['curated', 'qwen2.5-7b-instruct'],
    ])
  })

  it('shows the curated list alone while the catalog is unavailable', () => {
    expect(shape(foundryLocalRows({ curated, catalog: [], query: '' }))).toEqual([
      ['curated', 'qwen2.5-7b-instruct'],
    ])
  })

  it('shows the catalog alone when the curated list is empty (spec "Курированный список пуст")', () => {
    expect(shape(foundryLocalRows({ curated: [], catalog, query: '' }))).toEqual([
      ['microsoft', 'olmo-3-7b-instruct'],
      ['microsoft', 'mistral-nemo-12b-instruct'],
    ])
  })
})

const named = (name: string, tensorrt: CatalogModel['managed']): CatalogModel => ({
  ...entry(tensorrt),
  model_name: name,
})
const context = { engineId: 'tensorrt-llm', supportedArchitectures: supported, gpus: [card(24 * GB)] }

describe('managedBrowseRows', () => {
  it('puts the curated models first, then the feed narrowed and without repeats', () => {
    const rows = managedBrowseRows({
      curated: [named('nvidia/Qwen3-8B-FP8', { curated: true })],
      feed: [
        named('NVIDIA/qwen3-8b-fp8', { architectures: ['Qwen3ForCausalLM'] }),
        named('someone/Qwen3-14B-FP8', { architectures: ['Qwen3ForCausalLM'], parameters: { F8_E4M3: 14 * GB } }),
        named('someone/Mamba-7B', { architectures: ['MambaForCausalLM'] }),
        named('someone/Qwen3-235B', { architectures: ['Qwen3ForCausalLM'], parameters: { BF16: 235 * GB } }),
      ],
      context,
    })
    expect(rows.map((row) => [row.model.model_name, row.section])).toEqual([
      ['nvidia/Qwen3-8B-FP8', 'curated'],
      ['someone/Qwen3-14B-FP8', 'feed'],
    ])
  })
})

describe('managedSearchRows', () => {
  it('shows a repository typed exactly whatever the prefilter says, first, then the narrowed hits', () => {
    const rows = managedSearchRows({
      exact: named('someone/Mamba-7B', { architectures: ['MambaForCausalLM'] }),
      candidates: [
        named('someone/Mamba-7B', { architectures: ['MambaForCausalLM'] }),
        named('someone/Mamba-7B-v2', { architectures: ['MambaForCausalLM'] }),
        named('someone/Qwen3-4B', { architectures: ['Qwen3ForCausalLM'] }),
      ],
      context,
    })
    expect(rows.map((row) => [row.model.model_name, row.section])).toEqual([
      ['someone/Mamba-7B', 'exact'],
      ['someone/Qwen3-4B', 'feed'],
    ])
  })
})
