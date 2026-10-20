import { describe, expect, it } from 'vitest'

import {
  buildCloudModelCatalog,
  normalizeCloudModelId,
  searchCloudModels,
  searchCloudProviders,
} from '../cloud-model-catalog'

const provider = (name: string, ids: string[]): ProviderObject => ({
  provider: name,
  active: true,
  settings: [],
  models: ids.map((id) => ({ id }) as Model),
})

describe('normalizeCloudModelId', () => {
  it('drops the vendor prefix and the case', () => {
    expect(normalizeCloudModelId('openai/GPT-5.4')).toBe('gpt-5.4')
    expect(normalizeCloudModelId('gpt-5.4')).toBe('gpt-5.4')
    expect(normalizeCloudModelId('accounts/fireworks/models/llama-v3')).toBe(
      'llama-v3'
    )
  })
})

describe('buildCloudModelCatalog', () => {
  it('lists a model once with every provider that serves it, in provider order', () => {
    const catalog = buildCloudModelCatalog([
      provider('openai', ['gpt-5.4', 'gpt-5.4-mini']),
      provider('openrouter', ['openai/gpt-5.4', 'anthropic/claude-sonnet-5']),
      provider('anthropic', ['claude-sonnet-5', 'claude-sonnet-5']),
    ])

    expect(catalog).toEqual([
      { key: 'gpt-5.4', name: 'gpt-5.4', providers: ['openai', 'openrouter'] },
      { key: 'gpt-5.4-mini', name: 'gpt-5.4-mini', providers: ['openai'] },
      {
        key: 'claude-sonnet-5',
        name: 'anthropic/claude-sonnet-5',
        providers: ['openrouter', 'anthropic'],
      },
    ])
  })

  it('leaves out the local embedding stand-in', () => {
    expect(
      buildCloudModelCatalog([
        provider('openai', ['sentence-transformer-mini']),
      ])
    ).toEqual([])
  })
})

describe('search', () => {
  const catalog = buildCloudModelCatalog([
    provider('openai', ['gpt-5.4']),
    provider('openrouter', ['openai/gpt-5.4']),
  ])

  it('matches models by name or normalised id, and nothing on an empty query', () => {
    expect(searchCloudModels(catalog, 'GPT')).toHaveLength(1)
    expect(searchCloudModels(catalog, 'claude')).toEqual([])
    expect(searchCloudModels(catalog, '')).toEqual([])
  })

  it('matches providers by title or id, and keeps them all on an empty query', () => {
    const providers = [provider('openai', []), provider('chatgpt', [])]
    expect(
      searchCloudProviders(providers, 'gpt').map((p) => p.provider)
    ).toEqual(['chatgpt'])
    expect(searchCloudProviders(providers, 'OpenAI')).toHaveLength(1)
    expect(searchCloudProviders(providers, '')).toHaveLength(2)
  })
})
