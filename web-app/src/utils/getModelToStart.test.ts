import { beforeEach, describe, expect, it, vi } from 'vitest'
import { getLastUsedModel, getModelToStart } from './getModelToStart'

const { localStorageMock } = vi.hoisted(() => ({
  localStorageMock: {
    getItem: vi.fn(),
    setItem: vi.fn(),
    removeItem: vi.fn(),
    clear: vi.fn(),
    key: vi.fn(),
    length: 0,
  },
}))

vi.stubGlobal('localStorage', localStorageMock)

const embeddingModel = { id: 'sentence-transformer-mini' }
const healthyModel = { id: 'healthy-model' }
const missingModel = { id: 'missing-model', missing: true }

const provider = (models: Array<Record<string, unknown>>) => ({
  provider: 'llamacpp',
  models,
})

const getProviderByName = (p: Record<string, unknown>) => () => p as never

beforeEach(() => {
  localStorageMock.getItem.mockReset()
  localStorageMock.getItem.mockReturnValue(null)
})

describe('getLastUsedModel', () => {
  it('returns parsed JSON when present', () => {
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify({ provider: 'mlx', model: 'm1' })
    )
    expect(getLastUsedModel()).toEqual({ provider: 'mlx', model: 'm1' })
  })

  it('returns null when nothing stored', () => {
    expect(getLastUsedModel()).toBeNull()
  })

  it('returns null on corrupt JSON', () => {
    localStorageMock.getItem.mockReturnValue('{not json')
    expect(getLastUsedModel()).toBeNull()
  })
})

describe('getModelToStart', () => {
  it('returns the selected model when it is healthy', () => {
    const p = provider([healthyModel])
    const result = getModelToStart({
      selectedModel: healthyModel as never,
      selectedProvider: 'llamacpp',
      getProviderByName: getProviderByName(p),
    })
    expect(result?.model).toBe('healthy-model')
    expect(result?.provider).toBe(p)
  })

  it('skips a selected model with missing weights', () => {
    const p = provider([missingModel, healthyModel])
    const result = getModelToStart({
      selectedModel: missingModel as never,
      selectedProvider: 'llamacpp',
      getProviderByName: getProviderByName(p),
    })
    expect(result?.model).toBe('healthy-model')
  })

  it('skips the embedding model when selected', () => {
    const p = provider([embeddingModel, healthyModel])
    const result = getModelToStart({
      selectedModel: embeddingModel as never,
      selectedProvider: 'llamacpp',
      getProviderByName: getProviderByName(p),
    })
    expect(result?.model).toBe('healthy-model')
  })

  it('returns null when no usable model exists', () => {
    const p = provider([missingModel])
    const result = getModelToStart({
      selectedModel: missingModel as never,
      selectedProvider: 'llamacpp',
      getProviderByName: getProviderByName(p),
    })
    expect(result).toBeNull()
  })

  it('prefers a healthy last-used model over the selected one', () => {
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify({ provider: 'mlx', model: 'last-model' })
    )
    const mlx = provider([{ id: 'last-model' }])
    const llama = provider([healthyModel])
    const getProvider = (name: string) =>
      (name === 'mlx' ? mlx : llama) as never
    const result = getModelToStart({
      selectedModel: healthyModel as never,
      selectedProvider: 'llamacpp',
      getProviderByName: getProvider,
    })
    expect(result?.model).toBe('last-model')
    expect(result?.provider).toBe(mlx)
  })

  it('falls back to a healthy model when the last-used model is missing', () => {
    localStorageMock.getItem.mockReturnValue(
      JSON.stringify({ provider: 'mlx', model: 'gone-model' })
    )
    const mlx = provider([{ id: 'gone-model', missing: true }])
    const llama = provider([healthyModel])
    const getProvider = (name: string) =>
      (name === 'mlx' ? mlx : llama) as never
    const result = getModelToStart({
      selectedModel: undefined,
      selectedProvider: undefined,
      getProviderByName: getProvider,
    })
    expect(result?.model).toBe('healthy-model')
  })
})