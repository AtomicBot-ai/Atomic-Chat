import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

const {
  activateEmbedding,
  activateLocalEmbedding,
  stopEmbedding,
  activateDecision,
  stopDecision,
  raiseServer,
  localModels,
  platform,
} = vi.hoisted(() => ({
  activateEmbedding: vi.fn(),
  activateLocalEmbedding: vi.fn(),
  stopEmbedding: vi.fn(),
  activateDecision: vi.fn(),
  stopDecision: vi.fn(),
  raiseServer: vi.fn(),
  localModels: [] as Array<{
    id: string
    name: string
    model_path: string
    mmproj_path: string
  }>,
  platform: { localInference: true, turboquantEngine: true },
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({
    embedding: () => ({ isSupported: () => true }),
    decision: () => ({ isSupported: () => true }),
  }),
}))
vi.mock('@/hooks/useEmbeddingModel', () => ({
  useLocalEmbeddingModels: () => localModels,
}))
vi.mock('@/lib/embedding/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/embedding/models')>()),
  activateEmbeddingModel: activateEmbedding,
  activateLocalEmbeddingModel: activateLocalEmbedding,
  stopEmbeddingModel: stopEmbedding,
}))
vi.mock('@/lib/decision/models', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/decision/models')>()),
  activateDecisionModel: activateDecision,
  stopDecisionModel: stopDecision,
}))
vi.mock('@/utils/localApiServerControl', () => ({
  raiseLocalApiServerForMediaModel: raiseServer,
}))
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: (target, key) =>
        key in platform
          ? platform[key as keyof typeof platform]
          : target[key as keyof typeof target],
    }),
  }
})

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { decisionModelPath } from '@/lib/decision/models'
import { embeddingModelPath } from '@/lib/embedding/models'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'

import {
  NO_HELPER_MODEL,
  useServedDecisionModels,
  useServedEmbeddingModels,
} from '../useServedHelperModels'

const files = [{ role: 'model', path: 'model.gguf' }]
const embeddingModel = (id: string, name: string) =>
  ({ id, name, files }) as unknown as EmbeddingCatalogModel
const decisionModel = (
  id: string,
  name: string,
  engine: 'llamacpp' | 'llamacpp-upstream'
) => ({ id, name, engine, files }) as unknown as DecisionCatalogModel

describe('the embedding and decision models the server serves', () => {
  const qwen = embeddingModel('qwen3-embedding-0.6b', 'Qwen3 Embedding 0.6B')
  const gemma = embeddingModel('embeddinggemma-300m', 'EmbeddingGemma 300M')
  const laya = decisionModel('laya', 'Laya', 'llamacpp')
  const julia = decisionModel('julia-1', 'Julia 1', 'llamacpp-upstream')

  beforeEach(() => {
    vi.clearAllMocks()
    platform.localInference = true
    platform.turboquantEngine = true
    localModels.length = 0
    useLocalApiServer.setState({ pausedHelperModels: [] })
    const stub = { bind: () => () => {}, refresh: vi.fn() }
    useEmbeddingStore.setState({
      ...stub,
      catalog: { models: [qwen, gemma] } as never,
      installed: { [qwen.id]: true },
      config: null,
    })
    useDecisionStore.setState({
      ...stub,
      catalog: { models: [laya, julia] } as never,
      installed: { [laya.id]: true, [julia.id]: true },
      config: null,
    })
  })

  it('offers the downloaded embedding models and the llama.cpp embedding GGUFs', () => {
    localModels.push({
      id: 'bge-m3',
      name: 'bge-m3',
      model_path: 'llamacpp/models/bge-m3/model.gguf',
      mmproj_path: '',
    })
    const { result } = renderHook(() => useServedEmbeddingModels())

    expect(result.current.supported).toBe(true)
    expect(result.current.options).toEqual([
      { value: 'catalog:qwen3-embedding-0.6b', label: 'Qwen3 Embedding 0.6B' },
      { value: 'local:bge-m3', label: 'bge-m3' },
    ])
    expect(result.current.active).toBe(NO_HELPER_MODEL)
  })

  it('names the embedding model served only while it is switched on', () => {
    useEmbeddingStore.setState({
      config: { enabled: true, model_path: embeddingModelPath(qwen) } as never,
    })
    const { result, rerender } = renderHook(() => useServedEmbeddingModels())
    expect(result.current.active).toBe('catalog:qwen3-embedding-0.6b')

    act(() =>
      useEmbeddingStore.setState({
        config: {
          enabled: false,
          model_path: embeddingModelPath(qwen),
        } as never,
      })
    )
    rerender()
    expect(result.current.active).toBe(NO_HELPER_MODEL)
  })

  it('starts the chosen embedding model, brings the server up with it, and forgets a paused one', async () => {
    useLocalApiServer.setState({
      pausedHelperModels: ['embedding', 'decision'],
    })
    localModels.push({
      id: 'bge-m3',
      name: 'bge-m3',
      model_path: 'llamacpp/models/bge-m3/model.gguf',
      mmproj_path: '',
    })
    const { result } = renderHook(() => useServedEmbeddingModels())

    await act(() => result.current.apply('local:bge-m3'))

    expect(activateLocalEmbedding).toHaveBeenCalledWith(localModels[0])
    expect(activateEmbedding).not.toHaveBeenCalled()
    expect(raiseServer).toHaveBeenCalledTimes(1)
    // The next server start must not switch the previous model back on.
    expect(useLocalApiServer.getState().pausedHelperModels).toEqual([
      'decision',
    ])
  })

  it('switches the embedding model off for None', async () => {
    const { result } = renderHook(() => useServedEmbeddingModels())

    await act(() => result.current.apply(NO_HELPER_MODEL))

    expect(stopEmbedding).toHaveBeenCalledTimes(1)
    expect(raiseServer).not.toHaveBeenCalled()
  })

  it('offers the downloaded decision models with their engine, and names the one served', () => {
    useDecisionStore.setState({
      config: { enabled: true, model_path: decisionModelPath(julia) } as never,
    })
    const { result } = renderHook(() => useServedDecisionModels())

    expect(result.current.options).toEqual([
      { value: 'laya', label: 'Laya · TurboQuant' },
      { value: 'julia-1', label: 'Julia 1 · llama.cpp' },
    ])
    expect(result.current.active).toBe('julia-1')
  })

  it('leaves out TurboQuant decision models where the platform has no TurboQuant', () => {
    platform.turboquantEngine = false
    const { result } = renderHook(() => useServedDecisionModels())

    expect(result.current.options.map((option) => option.value)).toEqual([
      'julia-1',
    ])
  })

  it('starts the chosen decision model and brings the server up with it', async () => {
    const { result } = renderHook(() => useServedDecisionModels())

    await act(() => result.current.apply('laya'))

    expect(activateDecision).toHaveBeenCalledWith(laya)
    expect(raiseServer).toHaveBeenCalledTimes(1)
  })

  it('offers neither where the desktop cannot run local models', () => {
    platform.localInference = false

    expect(
      renderHook(() => useServedEmbeddingModels()).result.current.supported
    ).toBe(false)
    expect(
      renderHook(() => useServedDecisionModels()).result.current.supported
    ).toBe(false)
  })
})
