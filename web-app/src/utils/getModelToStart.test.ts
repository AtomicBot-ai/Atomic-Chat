import { beforeEach, describe, expect, it } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import { getModelToStart } from '@/utils/getModelToStart'

const makeProvider = (
  name: string,
  modelIds: string[],
  active = true
): ModelProvider =>
  ({
    provider: name,
    active,
    models: modelIds.map((id) => ({ id })),
    settings: [],
  }) as unknown as ModelProvider

const lookup =
  (providers: ModelProvider[]) =>
  (name: string): ModelProvider | undefined =>
    providers.find((p) => p.provider === name)

beforeEach(() => {
  localStorage.clear()
})

describe('getModelToStart', () => {
  it('skips a deactivated provider when picking the first local model', () => {
    const providers = [
      makeProvider('llamacpp-upstream', [], true),
      makeProvider('llamacpp', ['model-a'], false),
      makeProvider('mlx', ['model-b'], true),
    ]

    const result = getModelToStart({ getProviderByName: lookup(providers) })
    expect(result?.provider.provider).toBe('mlx')
    expect(result?.model).toBe('model-b')
  })

  it('never resurrects a deactivated provider via lastUsedModel', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp', model: 'model-a' })
    )
    const providers = [
      makeProvider('llamacpp-upstream', ['model-b'], true),
      makeProvider('llamacpp', ['model-a'], false),
    ]

    const result = getModelToStart({ getProviderByName: lookup(providers) })
    expect(result?.provider.provider).toBe('llamacpp-upstream')
    expect(result?.model).toBe('model-b')
  })

  it('still honors lastUsedModel on an active provider', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'llamacpp', model: 'model-a' })
    )
    const providers = [
      makeProvider('llamacpp-upstream', ['model-b'], true),
      makeProvider('llamacpp', ['model-a'], true),
    ]

    const result = getModelToStart({ getProviderByName: lookup(providers) })
    expect(result?.provider.provider).toBe('llamacpp')
    expect(result?.model).toBe('model-a')
  })

  it('ignores a stale selection pointing at a deactivated provider', () => {
    const providers = [
      makeProvider('llamacpp-upstream', ['model-b'], true),
      makeProvider('llamacpp', ['model-a'], false),
    ]

    const result = getModelToStart({
      selectedModel: { id: 'model-a' } as never,
      selectedProvider: 'llamacpp',
      getProviderByName: lookup(providers),
    })
    expect(result?.provider.provider).toBe('llamacpp-upstream')
  })

  it('returns null when only deactivated providers carry models', () => {
    const providers = [
      makeProvider('llamacpp-upstream', [], true),
      makeProvider('llamacpp', ['model-a'], false),
    ]

    expect(getModelToStart({ getProviderByName: lookup(providers) })).toBeNull()
  })
})
