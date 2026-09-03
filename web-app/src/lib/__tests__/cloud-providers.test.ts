import { describe, expect, it, vi } from 'vitest'

/**
 * The grouping asks the registry store what the catalogue ships, so the
 * catalogue is stated here rather than fetched: `my-hosted` and `my-vllm` are
 * absent from it on purpose — they are the user-added providers.
 */
const registryState = {
  hasInitialized: true,
  providers: [
    { provider: 'ollama' },
    { provider: 'llamacpp-server' },
    { provider: 'openai' },
    { provider: 'azure' },
    { provider: 'chatgpt' },
    // Flagship ids the real registry ships ahead of the baseline; only the
    // subscription-placement cases below build providers for them.
    { provider: 'anthropic' },
    { provider: 'openrouter' },
    { provider: 'mistral' },
    { provider: 'groq' },
    { provider: 'xai' },
  ],
}

vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: { getState: () => registryState },
}))

import {
  groupCloudProviders,
  isCloudProvider,
  isLocalEngineProvider,
  isProviderConnected,
  takesApiKey,
} from '@/lib/cloud-providers'
import { CHATGPT_BASE_URL } from '@/constants/providers'

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
  // The user's own llama-server, pointed at a box on the LAN rather than
  // loopback, with the optional `--api-key` setting it ships with.
  makeProvider('llamacpp-server', {
    base_url: 'http://192.168.1.50:8080/v1',
    settings: [apiKeySetting],
  }),
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
      ['llamacpp-upstream', 'llamacpp', 'mlx', 'foundation-models'].map(
        (name) => isLocalEngineProvider(byName(name))
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
  it('counts a saved key on its own, before any catalogue is fetched', () => {
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

  it('asks a keyless self-hosted server for models before calling it connected', () => {
    // Needing no key is not the same as being set up: an Ollama that has never
    // run answers nothing, so it gets no green dot.
    expect(isProviderConnected(byName('ollama'))).toBe(false)
    expect(isProviderConnected(byName('llamacpp-server'))).toBe(false)
    expect(
      isProviderConnected({
        ...byName('ollama'),
        models: [{ id: 'llama3' } as Model],
      })
    ).toBe(true)
  })

  it('stays false for a catalogue entry the user never connected', () => {
    // The registry ships openai with a model list; without a key it is an
    // advert, not a connection.
    expect(
      isProviderConnected({
        ...byName('openai'),
        models: [{ id: 'gpt-4o' } as Model],
      })
    ).toBe(false)
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
    const names = [...groups.selfHosted, ...groups.hosted].map(
      (p) => p.provider
    )
    expect(names).not.toContain('llamacpp-upstream')
    expect(names).not.toContain('future-engine')
  })

  it('groups loopback endpoints as self-hosted', () => {
    expect(groups.selfHosted.map((p) => p.provider)).toEqual([
      'ollama',
      'llamacpp-server',
      'my-hosted',
      'my-vllm',
    ])
  })

  it('keeps a self-hosted runtime self-hosted off loopback', () => {
    // Moving `llama-server` from `localhost` to the box under the desk does
    // not turn it into somebody else's cloud, and its optional `--api-key`
    // setting must not push it across the separator either.
    expect(groups.selfHosted.map((p) => p.provider)).toContain(
      'llamacpp-server'
    )
    expect(groups.hosted.map((p) => p.provider)).not.toContain(
      'llamacpp-server'
    )
  })

  it('files a user-added provider with self-hosted, not at the bottom', () => {
    // `my-hosted` looks exactly like a cloud — https URL, api-key setting, a
    // saved key — and is only distinguishable by being absent from the
    // catalogue. That is what "the user added it themselves" means here.
    expect(groups.selfHosted.map((p) => p.provider)).toContain('my-hosted')
  })

  it('groups catalogue clouds as hosted, in input order', () => {
    expect(groups.hosted.map((p) => p.provider)).toEqual(['openai', 'azure'])
  })

  it('covers every cloud provider exactly once', () => {
    const cloud = providers.filter(isCloudProvider)
    expect(groups.selfHosted.length + groups.hosted.length).toBe(cloud.length)
  })
})

describe('groupCloudProviders: subscription placement', () => {
  /** The registry order, with the baseline appended the way `seedProviders` does. */
  const catalogue = (): ProviderObject[] =>
    ['openai', 'anthropic', 'openrouter', 'mistral', 'groq', 'xai']
      .map((name) =>
        makeProvider(name, {
          base_url: `https://api.${name}.test/v1`,
          settings: [apiKeySetting],
        })
      )
      .concat(makeProvider('chatgpt', { base_url: CHATGPT_BASE_URL }))

  it('lifts the subscription to fifth, leaving the rest in registry order', () => {
    expect(
      groupCloudProviders(catalogue()).hosted.map((p) => p.provider)
    ).toEqual([
      'openai',
      'anthropic',
      'openrouter',
      'mistral',
      'chatgpt',
      'groq',
      'xai',
    ])
  })

  it('keeps it last when there is nothing to promote it past', () => {
    const short = [
      makeProvider('openai', {
        base_url: 'https://api.openai.com/v1',
        settings: [apiKeySetting],
      }),
      makeProvider('chatgpt', { base_url: CHATGPT_BASE_URL }),
    ]
    expect(groupCloudProviders(short).hosted.map((p) => p.provider)).toEqual([
      'openai',
      'chatgpt',
    ])
  })

  it('keeps the subscription out of the self-hosted group', () => {
    const groups = groupCloudProviders(catalogue())
    expect(groups.selfHosted.map((p) => p.provider)).not.toContain('chatgpt')
  })
})
