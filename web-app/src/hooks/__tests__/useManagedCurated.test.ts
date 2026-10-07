import { renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const models = vi.hoisted(() => ({
  fetchHfRevision: vi.fn(),
  checkManagedModel: vi.fn(),
  describeDescriptor: vi.fn(),
}))
vi.mock('@/services/managed-models/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/managed-models/models')>()),
  ...models,
}))

import { useManagedCurated } from '../useManagedCurated'
import { GatedModelError } from '@/services/managed-models/models'
import { resetManagedVerdictsForTests } from '@/services/managed-models/verdict'
import type {
  CuratedModel,
  DescriptorSummary,
  ModelCompatibility,
} from '@/services/managed-environment/types'

const compatible: ModelCompatibility = {
  architectures: ['Qwen3ForCausalLM'],
  quantization_format: 'fp8',
  weight_bytes: 8e9,
  checked_gpu_id: 'GPU-1',
  curated: true,
  unified_memory: false,
  fits_other_gpus: [],
  verdict: { ok: true },
}
const refused = (fitsOther: string[]): ModelCompatibility => ({
  ...compatible,
  fits_other_gpus: fitsOther,
  verdict: {
    ok: false,
    error: { code: 'MODEL_INCOMPATIBLE', message: 'Needs compute capability 10.0, the card has 8.9.' },
  },
})

const curated = (repository: string, revision: string): CuratedModel => ({
  repository,
  revision,
  inventory_digest: `sha256:${'a'.repeat(64)}`,
  vram_tier_bytes: 16e9,
  note: `${repository} note`,
})

const descriptor: DescriptorSummary = {
  descriptor_id: 'tensorrt-llm-1.3.0rc29-r2',
  engine_id: 'tensorrt-llm',
  notices: [],
  curated_models: [
    curated('nvidia/Qwen3-8B-FP8', 'rev-a'),
    curated('nvidia/Qwen3.5-122B-NVFP4', 'rev-b'),
    curated('nvidia/Gemma-4-31B-FP8', 'rev-c'),
  ],
  supported_architectures: ['Qwen3ForCausalLM', 'Gemma4ForConditionalGeneration'],
}

const verdicts: Record<string, ModelCompatibility> = {
  'nvidia/Qwen3-8B-FP8': compatible,
  // Fits no card of this machine.
  'nvidia/Qwen3.5-122B-NVFP4': refused([]),
  // Too big for the default card, fits the other one.
  'nvidia/Gemma-4-31B-FP8': refused(['GPU-2']),
}

beforeEach(() => {
  vi.clearAllMocks()
  resetManagedVerdictsForTests()
  models.describeDescriptor.mockResolvedValue(descriptor)
  models.fetchHfRevision.mockImplementation(async (repository: string, revision?: string) => ({
    repository,
    revision: `${revision}-sha`,
    config_json: {},
    hf_quant_config_json: null,
    files: [],
  }))
  models.checkManagedModel.mockImplementation(async (_engine: string, { repository }: { repository: string }) =>
    verdicts[repository]
  )
})

describe('useManagedCurated', () => {
  it('lists the descriptor curated models that run on at least one card, as Hub cards, in its order', async () => {
    const { result } = renderHook(() => useManagedCurated('tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models.map((model) => model.model_name)).toEqual([
      'nvidia/Qwen3-8B-FP8',
      'nvidia/Gemma-4-31B-FP8',
    ])
    expect(result.current.models[0]).toMatchObject({
      developer: 'nvidia',
      is_managed: true,
      managed: { curated: true, revision: 'rev-a' },
    })
    expect(result.current.supportedArchitectures).toEqual(descriptor.supported_architectures)
    // Each is read at the revision the descriptor pins.
    expect(models.fetchHfRevision).toHaveBeenCalledWith('nvidia/Qwen3-8B-FP8', 'rev-a', undefined)
    expect(models.describeDescriptor).toHaveBeenCalledWith('tensorrt-llm-1.3.0rc29-r2')
  })

  it('keeps a curated model the core never judged — gated, or Hugging Face unreachable — for its card to explain', async () => {
    models.fetchHfRevision.mockImplementation(async (repository: string, revision?: string) => {
      if (repository === 'nvidia/Qwen3.5-122B-NVFP4') throw new Error('network down')
      if (repository === 'nvidia/Gemma-4-31B-FP8') throw new GatedModelError(repository)
      return { repository, revision: `${revision}-sha`, config_json: {}, hf_quant_config_json: null, files: [] }
    })

    const { result } = renderHook(() => useManagedCurated('tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2'))

    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models.map((model) => model.model_name)).toEqual([
      'nvidia/Qwen3-8B-FP8',
      'nvidia/Qwen3.5-122B-NVFP4',
      'nvidia/Gemma-4-31B-FP8',
    ])
  })

  it('asks the core again for nothing it already answered this session', async () => {
    const first = renderHook(() => useManagedCurated('tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2'))
    await waitFor(() => expect(first.result.current.loading).toBe(false))
    first.unmount()
    const checks = models.checkManagedModel.mock.calls.length

    const again = renderHook(() => useManagedCurated('tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2'))
    await waitFor(() => expect(again.result.current.models).toHaveLength(2))
    expect(models.checkManagedModel.mock.calls.length).toBe(checks)
  })

  it('lists nothing when the core does not hold the descriptor, and asks nothing without one', async () => {
    models.describeDescriptor.mockResolvedValue(null)
    const { result } = renderHook(() => useManagedCurated('tensorrt-llm', 'tensorrt-llm-unknown'))
    await waitFor(() => expect(result.current.loading).toBe(false))
    expect(result.current.models).toEqual([])
    expect(result.current.supportedArchitectures).toBeNull()

    const none = renderHook(() => useManagedCurated('tensorrt-llm', null))
    expect(none.result.current).toMatchObject({ models: [], loading: false })
    expect(models.describeDescriptor).toHaveBeenCalledTimes(1)
  })

  it('checks an engine\'s curated models with that engine, and keeps its verdicts apart from another engine\'s', async () => {
    // The second engine refuses for every card what TensorRT-LLM accepts.
    models.checkManagedModel.mockImplementation(async (engine: string, { repository }: { repository: string }) =>
      engine === 'second-engine' ? refused([]) : verdicts[repository]
    )
    const trt = renderHook(() => useManagedCurated('tensorrt-llm', 'tensorrt-llm-1.3.0rc29-r2'))
    await waitFor(() => expect(trt.result.current.loading).toBe(false))
    const second = renderHook(() => useManagedCurated('second-engine', 'second-engine-1-r1'))
    await waitFor(() => expect(second.result.current.loading).toBe(false))

    expect(trt.result.current.models.map((model) => model.model_name)).toContain('nvidia/Qwen3-8B-FP8')
    expect(second.result.current.models).toEqual([])
    expect(models.checkManagedModel).toHaveBeenCalledWith('second-engine', expect.objectContaining({ repository: 'nvidia/Qwen3-8B-FP8' }))
  })
})
