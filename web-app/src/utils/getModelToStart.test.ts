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
  it('falls back to a usable local model when the saved selection is corrupt', () => {
    localStorage.setItem(localStorageKey.lastUsedModel, '{invalid json')
    const provider = makeProvider('llamacpp-upstream', ['model-b'])

    expect(getModelToStart({ getProviderByName: lookup([provider]) })).toEqual({
      model: 'model-b',
      provider,
    })
  })

  it('uses the current selection on an active provider before the local fallback', () => {
    const local = makeProvider('llamacpp-upstream', ['model-b'])
    const selected = makeProvider('custom-provider', ['selected-model'])

    expect(getModelToStart({
      selectedModel: { id: 'selected-model' } as never,
      selectedProvider: 'custom-provider',
      getProviderByName: lookup([local, selected]),
    })).toEqual({ model: 'selected-model', provider: selected })
  })

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

  it('uses the active selection when the saved provider is gone and no local fallback exists', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider: 'removed-server', model: 'old-model' })
    )
    const selected = makeProvider('custom-provider', ['selected-model'])

    expect(getModelToStart({
      selectedModel: { id: 'selected-model' } as never,
      selectedProvider: 'custom-provider',
      getProviderByName: lookup([selected]),
    })).toEqual({ model: 'selected-model', provider: selected })
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

  it('honors an active selection when there is no lastUsedModel', () => {
    // The selected-model branch is only reachable with the localStorage entry
    // absent — otherwise lastUsedModel resolves or falls through to the first
    // local model, and this path is never taken.
    const providers = [
      makeProvider('llamacpp-upstream', ['model-b'], true),
      makeProvider('llamacpp', ['model-a'], true),
    ]

    const result = getModelToStart({
      selectedModel: { id: 'model-a' } as never,
      selectedProvider: 'llamacpp',
      getProviderByName: lookup(providers),
    })
    expect(result?.provider.provider).toBe('llamacpp')
    expect(result?.model).toBe('model-a')
  })

  it('falls through when the stored lastUsedModel is unreadable', () => {
    // A half-written or hand-edited entry must not throw out of startup; the
    // reader swallows it and the caller picks the first local model instead.
    localStorage.setItem(localStorageKey.lastUsedModel, '{ not json')
    const providers = [makeProvider('llamacpp-upstream', ['model-b'], true)]

    const result = getModelToStart({ getProviderByName: lookup(providers) })
    expect(result?.provider.provider).toBe('llamacpp-upstream')
    expect(result?.model).toBe('model-b')
  })

  it('returns null when only deactivated providers carry models', () => {
    const providers = [
      makeProvider('llamacpp-upstream', [], true),
      makeProvider('llamacpp', ['model-a'], false),
    ]

    expect(getModelToStart({ getProviderByName: lookup(providers) })).toBeNull()
  })
})
