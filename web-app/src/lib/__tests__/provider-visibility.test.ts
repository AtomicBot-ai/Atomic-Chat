import { describe, expect, it, vi } from 'vitest'

import { isEngineHidden, refreshManagedProviders } from '../provider-visibility'

/** An engine that decides for itself whether it belongs in the lists, like TensorRT-LLM's. */
function gated(visible: boolean) {
  let shown = visible
  return {
    isHidden: () => !shown,
    refreshVisibility: vi.fn(async () => shown),
    setVisible(next: boolean) {
      shown = next
    },
  }
}

describe('isEngineHidden', () => {
  it('hides only an engine that says it is hidden', () => {
    expect(isEngineHidden(gated(false))).toBe(true)
    expect(isEngineHidden(gated(true))).toBe(false)
    // Every other engine has no say and is always listed.
    expect(isEngineHidden({ list: () => [] })).toBe(false)
    expect(isEngineHidden(undefined)).toBe(false)
  })
})

describe('refreshManagedProviders', () => {
  const provider = (name: string) => ({ provider: name }) as ModelProvider

  /** The persisted provider store in miniature: it keeps what it was given, as the real one does. */
  function store(initial: string[]) {
    let providers = initial.map(provider)
    return {
      get providers() {
        return providers
      },
      setProviders(next: ModelProvider[]) {
        const kept = providers.filter(
          (p) => !next.some((n) => n.provider === p.provider)
        )
        providers = [...next, ...kept]
      },
      deleteProvider(name: string) {
        providers = providers.filter((p) => p.provider !== name)
      },
      names() {
        return providers.map((p) => p.provider).sort()
      },
    }
  }

  it('re-asks every gated engine and lists a provider that became visible, without a restart', async () => {
    const trt = gated(true)
    const engines = new Map<string, unknown>([
      ['tensorrt-llm', trt],
      ['llamacpp-upstream', { list: vi.fn() }],
    ])
    const providers = store(['llamacpp-upstream'])

    const refreshed = await refreshManagedProviders({
      engines,
      getProviders: async () => [
        provider('llamacpp-upstream'),
        provider('tensorrt-llm'),
      ],
      store: providers,
    })

    expect(refreshed).toBe(true)
    expect(trt.refreshVisibility).toHaveBeenCalledTimes(1)
    expect(providers.names()).toEqual(['llamacpp-upstream', 'tensorrt-llm'])
  })

  it('removes a provider that was shown before and is hidden now', async () => {
    // The store keeps every provider it ever saw, so leaving it out of the list is not enough.
    const providers = store(['llamacpp-upstream', 'tensorrt-llm'])

    await refreshManagedProviders({
      engines: new Map([['tensorrt-llm', gated(false)]]),
      getProviders: async () => [provider('llamacpp-upstream')],
      store: providers,
    })

    expect(providers.names()).toEqual(['llamacpp-upstream'])
  })

  it('keeps a provider whose engine could not find out, rather than dropping its settings', async () => {
    // A core that did not answer is not a machine without an NVIDIA GPU.
    const unsure = { ...gated(false), visibilityKnown: () => false }
    const providers = store(['tensorrt-llm'])

    await refreshManagedProviders({
      engines: new Map([['tensorrt-llm', unsure]]),
      getProviders: async () => [],
      store: providers,
    })

    expect(providers.names()).toEqual(['tensorrt-llm'])
  })

  it('does not re-read every provider when nothing about the gated one changed', async () => {
    const getProviders = vi.fn(async () => [provider('tensorrt-llm')])
    const providers = store(['tensorrt-llm'])

    await refreshManagedProviders({
      engines: new Map([['tensorrt-llm', gated(true)]]),
      getProviders,
      store: providers,
    })

    expect(getProviders).not.toHaveBeenCalled()
    expect(providers.names()).toEqual(['tensorrt-llm'])
  })

  it('re-reads a shown provider whose stored settings are older than its extension’s', async () => {
    // Windows acceptance, 2026-10-06: vLLM was stored with its first 8 settings; the rebuilt
    // extension registered 20, and the provider page kept showing 8.
    const key = (k: string) => ({ key: k })
    const fresh = [
      'gpu_id',
      'context_length',
      'kv_cache_memory_gib',
      'gpu_memory_utilization',
    ]
    const engine = { ...gated(true), getSettings: async () => fresh.map(key) }
    let providers = [
      {
        provider: 'vllm',
        settings: ['gpu_id', 'context_length', 'kv_cache_max_tokens'].map(key),
      },
    ]
    const getProviders = vi.fn(async () => [
      {
        provider: 'vllm',
        settings: fresh.map(key),
      } as unknown as ModelProvider,
    ])

    await refreshManagedProviders({
      engines: new Map([['vllm', engine]]),
      getProviders,
      store: {
        get providers() {
          return providers
        },
        setProviders(next) {
          providers = next as unknown as typeof providers
        },
        deleteProvider() {},
      },
    })

    expect(getProviders).toHaveBeenCalledTimes(1)
    expect(providers[0]?.settings?.map((s) => s.key)).toEqual(fresh)
  })

  it('does not re-read a shown provider whose stored settings match its extension’s', async () => {
    const engine = {
      ...gated(true),
      getSettings: async () => [{ key: 'gpu_id' }],
    }
    const getProviders = vi.fn(async () => [])
    const stored = [{ provider: 'vllm', settings: [{ key: 'gpu_id' }] }]
    let providers = stored
    await refreshManagedProviders({
      engines: new Map([['vllm', engine]]),
      getProviders,
      store: {
        get providers() {
          return providers
        },
        setProviders(next) {
          providers = next as unknown as typeof providers
        },
        deleteProvider() {},
      },
    })
    expect(getProviders).not.toHaveBeenCalled()
    // The stored provider, settings included, is left exactly as it was.
    expect(providers).toBe(stored)
    expect(providers[0]?.settings?.map((s) => s.key)).toEqual(['gpu_id'])
  })

  it('does nothing at all when no engine is gated', async () => {
    const getProviders = vi.fn()
    const providers = store(['mlx'])

    const refreshed = await refreshManagedProviders({
      engines: new Map([['mlx', { list: vi.fn() }]]),
      getProviders,
      store: providers,
    })

    expect(refreshed).toBe(false)
    expect(getProviders).not.toHaveBeenCalled()
    expect(providers.names()).toEqual(['mlx'])
  })
})
