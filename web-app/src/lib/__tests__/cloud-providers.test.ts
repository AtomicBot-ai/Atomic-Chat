import { describe, expect, it } from 'vitest'
import {
  groupCloudProviders,
  isCloudProvider,
  isLocalEngineProvider,
  isProviderConnected,
  takesApiKey,
} from '@/lib/cloud-providers'

const apiKeySetting: ProviderSetting = {
  key: 'api-key',
  title: 'API Key',
  description: '',
  controller_type: 'input',
  controller_props: { value: '', type: 'password' },
}

const makeProvider = (
  provider: string,
  overrides: Partial<ProviderObject> = {}
): ProviderObject => ({
  provider,
  active: true,
  models: [],
  settings: [],
  ...overrides,
})

/**
 * One fixture shared by every case, so the partition invariant is asserted over
 * the same list the individual expectations describe.
 */
const providers: ProviderObject[] = [
  makeProvider('llamacpp-upstream', { persist: true }),
  makeProvider('llamacpp', { persist: true }),
  makeProvider('mlx', { persist: true }),
  makeProvider('foundation-models', { persist: true }),
  // A runtime engine that is not in LOCAL_PROVIDER_NAMES yet: `persist` alone
  // must be enough to keep it in Settings.
  makeProvider('future-engine', { persist: true }),
  makeProvider('ollama', { base_url: 'http://localhost:11434/v1' }),
  makeProvider('openai', {
    base_url: 'https://api.openai.com/v1',
    settings: [apiKeySetting],
  }),
  makeProvider('azure', {
    base_url: 'https://YOUR-RESOURCE-NAME.openai.azure.com/openai/v1',
    settings: [apiKeySetting],
  }),
  makeProvider('my-hosted', {
    base_url: 'https://example.test/v1',
    settings: [apiKeySetting],
    api_key: 'sk-abc',
  }),
  makeProvider('my-vllm', {
    base_url: 'http://127.0.0.1:8000/v1',
    settings: [apiKeySetting],
  }),
]

const byName = (name: string): ProviderObject => {
  const found = providers.find((p) => p.provider === name)
  if (!found) throw new Error(`fixture missing: ${name}`)
  return found
}

describe('isLocalEngineProvider / isCloudProvider', () => {
  it('partitions the provider list with nothing left over', () => {
    const local = providers.filter(isLocalEngineProvider)
    const cloud = providers.filter(isCloudProvider)

    expect(local.length + cloud.length).toBe(providers.length)
    expect(local.some((p) => cloud.includes(p))).toBe(false)
  })

  it('keeps every local engine in Settings', () => {
    expect(
      ['llamacpp-upstream', 'llamacpp', 'mlx', 'foundation-models'].map((name) =>
        isLocalEngineProvider(byName(name))
      )
    ).toEqual([true, true, true, true])
  })

  it('treats `persist: true` alone as a local engine', () => {
    expect(isLocalEngineProvider(byName('future-engine'))).toBe(true)
  })

  it('puts ollama on the Cloud page rather than nowhere', () => {
    expect(isCloudProvider(byName('ollama'))).toBe(true)
    expect(isLocalEngineProvider(byName('ollama'))).toBe(false)
  })

  it('puts user-created providers on the Cloud page', () => {
    expect(isCloudProvider(byName('my-vllm'))).toBe(true)
    expect(isCloudProvider(byName('my-hosted'))).toBe(true)
  })
})

describe('isProviderConnected', () => {
  it('is true for a keyless loopback provider', () => {
    expect(isProviderConnected(byName('ollama'))).toBe(true)
  })

  it('is true once a key is saved', () => {
    expect(isProviderConnected(byName('my-hosted'))).toBe(true)
  })

  it('is false for a registry provider with no key', () => {
    expect(isProviderConnected(byName('openai'))).toBe(false)
    expect(isProviderConnected(byName('azure'))).toBe(false)
  })

  it('rejects a whitespace-only key', () => {
    const provider = makeProvider('openai', {
      base_url: 'https://api.openai.com/v1',
      settings: [apiKeySetting],
      api_key: '   ',
    })
    expect(isProviderConnected(provider)).toBe(false)
  })
})

describe('takesApiKey', () => {
  it('distinguishes key-taking providers from keyless ones', () => {
    expect(takesApiKey(byName('openai'))).toBe(true)
    expect(takesApiKey(byName('ollama'))).toBe(false)
  })
})

describe('groupCloudProviders', () => {
  const groups = groupCloudProviders(providers)

  it('drops every local engine', () => {
    const names = [...groups.selfHosted, ...groups.hosted].map((p) => p.provider)
    expect(names).not.toContain('llamacpp-upstream')
    expect(names).not.toContain('future-engine')
  })

  it('groups loopback endpoints as self-hosted', () => {
    expect(groups.selfHosted.map((p) => p.provider)).toEqual([
      'ollama',
      'my-vllm',
    ])
  })

  it('groups key-taking remote endpoints as hosted, in input order', () => {
    expect(groups.hosted.map((p) => p.provider)).toEqual([
      'openai',
      'azure',
      'my-hosted',
    ])
  })

  it('covers every cloud provider exactly once', () => {
    const cloud = providers.filter(isCloudProvider)
    expect(groups.selfHosted.length + groups.hosted.length).toBe(cloud.length)
  })
})
