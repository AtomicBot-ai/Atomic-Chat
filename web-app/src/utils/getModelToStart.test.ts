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

  // AC-01: project indexing loads the embedding model, and a build that let
  // the composer select it left it behind as the last-used model.
  it('never starts an embedding model as the last used or first local model', () => {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({
        provider: 'llamacpp-upstream',
        model: 'sentence-transformer-mini',
      })
    )
    const providers = [
      {
        ...makeProvider('llamacpp-upstream', ['sentence-transformer-mini']),
        models: [
          { id: 'sentence-transformer-mini' },
          { id: 'nomic-embed.gguf', embedding: true },
        ],
      } as unknown as ModelProvider,
      makeProvider('mlx', ['model-b'], true),
    ]

    const result = getModelToStart({ getProviderByName: lookup(providers) })
    expect(result?.provider.provider).toBe('mlx')
    expect(result?.model).toBe('model-b')
  })
})
