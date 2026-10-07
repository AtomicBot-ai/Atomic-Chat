import { beforeEach, describe, expect, it, vi } from 'vitest'

const installedIds = vi.hoisted(() => new Set<string>())

vi.mock('@/lib/embedding/models', () => ({
  isEmbeddingModelInstalled: vi.fn(async (model: { id: string }) =>
    installedIds.has(model.id)
  ),
}))

vi.mock('@/services/embedding-catalog-registry', async (importOriginal) => {
  const actual =
    await importOriginal<
      typeof import('@/services/embedding-catalog-registry')
    >()
  return {
    ...actual,
    fetchEmbeddingCatalog: vi.fn(async () => ({
      catalog: actual.getBaselineEmbeddingCatalog(),
      source: 'baseline',
    })),
  }
})

import { seedServiceHub } from '@/test/service-hub'
import type {
  EmbeddingEvent,
  EmbeddingService,
  EmbeddingStatus,
} from '@/services/embedding/types'

import { toEmbeddingError, useEmbeddingStore } from '../embedding-store'

const status = (state: EmbeddingStatus['state']): EmbeddingStatus =>
  ({ state, error: null }) as unknown as EmbeddingStatus

const fakeService = (supported = true) => {
  let handler: ((event: EmbeddingEvent) => void) | null = null
  const unsubscribe = vi.fn()
  const service = {
    isSupported: () => supported,
    getConfig: vi.fn().mockResolvedValue({
      config: { model_path: 'embedding/models/bge-m3/bge-m3-q8_0.gguf' },
      status: status('idle'),
    }),
    subscribe: vi.fn((h: (event: EmbeddingEvent) => void) => {
      handler = h
      return unsubscribe
    }),
  }
  seedServiceHub({ embedding: service as unknown as EmbeddingService })
  return {
    service,
    unsubscribe,
    emit: (event: EmbeddingEvent) => handler?.(event),
  }
}

const initial = useEmbeddingStore.getState()

beforeEach(() => {
  installedIds.clear()
  useEmbeddingStore.setState(initial, true)
})

describe('toEmbeddingError', () => {
  it('keeps the core error shape', () => {
    expect(
      toEmbeddingError({
        code: 'EMBEDDING_ENGINE_UNSUPPORTED',
        message: 'Update llama.cpp to b11454 or newer.',
        details: 'd',
      })
    ).toEqual({
      code: 'EMBEDDING_ENGINE_UNSUPPORTED',
      message: 'Update llama.cpp to b11454 or newer.',
      details: 'd',
    })
  })

  it('wraps anything else', () => {
    expect(toEmbeddingError(new Error('boom'))).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'boom',
    })
    expect(toEmbeddingError('nope')).toEqual({
      code: 'INTERNAL_ERROR',
      message: 'nope',
    })
  })
})

describe('useEmbeddingStore', () => {
  it('starts from the baseline catalog', () => {
    expect(useEmbeddingStore.getState().catalog.models.length).toBeGreaterThan(
      0
    )
  })

  it('reads the config and status on refresh', async () => {
    fakeService()
    await useEmbeddingStore.getState().refresh()
    expect(useEmbeddingStore.getState().config?.model_path).toBe(
      'embedding/models/bge-m3/bge-m3-q8_0.gguf'
    )
    expect(useEmbeddingStore.getState().status?.state).toBe('idle')
  })

  it('keeps a failed refresh as the error', async () => {
    const { service } = fakeService()
    service.getConfig.mockRejectedValue({
      code: 'EMBEDDING_UNAVAILABLE',
      message: 'old core',
    })
    await useEmbeddingStore.getState().refresh()
    expect(useEmbeddingStore.getState().error?.code).toBe(
      'EMBEDDING_UNAVAILABLE'
    )
  })

  it('marks which catalog models are on disk', async () => {
    const [first] = useEmbeddingStore.getState().catalog.models
    installedIds.add(first.id)
    await useEmbeddingStore.getState().refreshInstalled()
    const { installed } = useEmbeddingStore.getState()
    expect(installed[first.id]).toBe(true)
    expect(Object.values(installed).filter(Boolean)).toHaveLength(1)
  })

  it('follows the core events once bound', async () => {
    const { service, unsubscribe, emit } = fakeService()
    const unbind = useEmbeddingStore.getState().bind()
    await vi.waitFor(() =>
      expect(useEmbeddingStore.getState().status?.state).toBe('idle')
    )

    emit({
      type: 'error',
      error: { code: 'MODEL_LOAD_FAILED', message: 'x' },
    })
    expect(useEmbeddingStore.getState().error?.code).toBe('MODEL_LOAD_FAILED')

    emit({ type: 'state', status: status('ready') })
    expect(useEmbeddingStore.getState().status?.state).toBe('ready')
    expect(useEmbeddingStore.getState().error).toBeNull()

    emit({ type: 'reset' })
    await vi.waitFor(() => expect(service.getConfig).toHaveBeenCalledTimes(2))

    unbind()
    expect(unsubscribe).toHaveBeenCalledOnce()
  })

  it('does nothing off the desktop', () => {
    const { service } = fakeService(false)
    useEmbeddingStore.getState().bind()()
    expect(service.subscribe).not.toHaveBeenCalled()
    expect(useEmbeddingStore.getState().status).toBeNull()
  })
})
