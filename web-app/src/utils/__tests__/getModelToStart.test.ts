import { describe, it, expect, beforeEach, vi } from 'vitest'
import { getLastUsedModel, getModelToStart } from '../getModelToStart'
import { localStorageKey } from '@/constants/localStorage'
import { EMBEDDING_MODEL_ID } from '@/constants/models'

function makeProvider(
  provider: string,
  models: Array<{ id: string; missing?: boolean }>
): ModelProvider {
  return {
    provider,
    active: true,
    models,
  } as unknown as ModelProvider
}

describe('getLastUsedModel', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('returns null when nothing is stored', () => {
    expect(getLastUsedModel()).toBeNull()
  })

  it('parses a stored value', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp-upstream', model: 'qwen3-4b' })
    )
    expect(getLastUsedModel()).toEqual({
      provider: 'llamacpp-upstream',
      model: 'qwen3-4b',
    })
  })

  it('returns null and does not throw on malformed JSON', () => {
    localStorage.setItem(localStorageKey.lastUsedModel, '{not-json')
    const debugSpy = vi.spyOn(console, 'debug').mockImplementation(() => {})
    expect(getLastUsedModel()).toBeNull()
    debugSpy.mockRestore()
  })
})

describe('getModelToStart', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  it('prefers the last-used model when its provider/model still exist', () => {
    const provider = makeProvider('llamacpp-upstream', [{ id: 'qwen3-4b' }])
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp-upstream', model: 'qwen3-4b' })
    )
    const getProviderByName = vi.fn((name: string) =>
      name === 'llamacpp-upstream' ? provider : undefined
    )

    const result = getModelToStart({ getProviderByName })

    expect(result).toEqual({ model: 'qwen3-4b', provider })
  })

  it('falls back to the first usable local model when the last-used model is missing (broken link)', () => {
    const brokenProvider = makeProvider('llamacpp-upstream', [
      { id: 'qwen3-4b', missing: true },
    ])
    const mlxProvider = makeProvider('mlx', [{ id: 'gemma-4-e4b' }])
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp-upstream', model: 'qwen3-4b' })
    )
    const getProviderByName = vi.fn((name: string) => {
      if (name === 'llamacpp-upstream') return brokenProvider
      if (name === 'mlx') return mlxProvider
      return undefined
    })

    const result = getModelToStart({ getProviderByName })

    expect(result).toEqual({ model: 'gemma-4-e4b', provider: mlxProvider })
  })

  it('falls back to the first usable local model when the last-used provider no longer exists', () => {
    const mlxProvider = makeProvider('mlx', [{ id: 'gemma-4-e4b' }])
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'gone-provider', model: 'ghost' })
    )
    const getProviderByName = vi.fn((name: string) =>
      name === 'mlx' ? mlxProvider : undefined
    )

    const result = getModelToStart({ getProviderByName })

    expect(result).toEqual({ model: 'gemma-4-e4b', provider: mlxProvider })
  })

  it('uses the selected model/provider when there is no last-used model', () => {
    const provider = makeProvider('openai', [{ id: 'gpt-5.4' }])
    const getProviderByName = vi.fn((name: string) =>
      name === 'openai' ? provider : undefined
    )

    const result = getModelToStart({
      selectedModel: { id: 'gpt-5.4' } as never,
      selectedProvider: 'openai',
      getProviderByName,
    })

    expect(result).toEqual({ model: 'gpt-5.4', provider })
  })

  it('ignores the selected model when its provider cannot be resolved', () => {
    const getProviderByName = vi.fn(() => undefined)

    const result = getModelToStart({
      selectedModel: { id: 'gpt-5.4' } as never,
      selectedProvider: 'openai',
      getProviderByName,
    })

    expect(result).toBeNull()
  })

  it('prefers llamacpp-upstream over llamacpp and mlx when auto-picking a local model', () => {
    const upstream = makeProvider('llamacpp-upstream', [{ id: 'a' }])
    const turboquant = makeProvider('llamacpp', [{ id: 'b' }])
    const mlx = makeProvider('mlx', [{ id: 'c' }])
    const getProviderByName = vi.fn((name: string) => {
      if (name === 'llamacpp-upstream') return upstream
      if (name === 'llamacpp') return turboquant
      if (name === 'mlx') return mlx
      return undefined
    })

    const result = getModelToStart({ getProviderByName })

    expect(result).toEqual({ model: 'a', provider: upstream })
  })

  it('skips the embedding model and missing models when auto-picking', () => {
    const provider = makeProvider('llamacpp-upstream', [
      { id: EMBEDDING_MODEL_ID },
      { id: 'broken', missing: true },
      { id: 'usable' },
    ])
    const getProviderByName = vi.fn((name: string) =>
      name === 'llamacpp-upstream' ? provider : undefined
    )

    const result = getModelToStart({ getProviderByName })

    expect(result).toEqual({ model: 'usable', provider })
  })

  it('returns null when no local provider has a usable model', () => {
    const getProviderByName = vi.fn(() => undefined)

    const result = getModelToStart({ getProviderByName })

    expect(result).toBeNull()
  })
})
