import { beforeEach, describe, expect, it, vi } from 'vitest'

const registry = vi.hoisted(() => ({
  register: vi.fn(async () => true),
  unregister: vi.fn(async () => {}),
}))

vi.mock('@/utils/registerRemoteProvider', () => ({
  registerRemoteProvider: registry.register,
  unregisterRemoteProvider: registry.unregister,
  isLocalProvider: () => false,
}))

import { useModelProvider } from '@/hooks/useModelProvider'
import { canDeleteProvider } from '@/hooks/useDeleteProvider'
import {
  isAccountManagedProvider,
  managedProviderName,
  syncAccountRemoteProviders,
} from '@/lib/account-remote-providers'
import type { RemoteProviderConnection } from '@/services/account/remote-types'

const fetchModels = vi.fn(
  async (): Promise<string[]> => ['qwen3-8b', 'gemma-3']
)
const hub = { providers: () => ({ fetchModelsFromProvider: fetchModels }) }

const studio: RemoteProviderConnection = {
  hostId: 'host-1',
  hostName: 'Studio Mac',
  baseUrl: 'https://first-words.trycloudflare.com/v1',
  apiKey: 'sk-atomic-first',
  endpointsSeq: 1,
}

const byName = (name: string) =>
  useModelProvider.getState().getProviderByName(name)

const sync = (
  connections: RemoteProviderConnection[],
  options?: Parameters<typeof syncAccountRemoteProviders>[2]
) =>
  syncAccountRemoteProviders(
    connections,
    hub as unknown as Parameters<typeof syncAccountRemoteProviders>[1],
    options
  )

const modelIds = () =>
  byName('Studio Mac (remote)')?.models.map((m) => m.id) ?? []

describe('account remote providers', () => {
  beforeEach(async () => {
    useModelProvider.setState({ providers: [] })
    // Forget the address list numbers an earlier test left behind.
    await sync([])
    registry.register.mockClear()
    registry.unregister.mockClear()
    fetchModels.mockClear()
  })

  it('adds a connected computer as "<name> (remote)" with its address, key and models', async () => {
    await sync([studio])

    const provider = byName('Studio Mac (remote)')
    expect(provider).toBeDefined()
    expect(provider?.account_remote).toEqual({ host_id: 'host-1' })
    expect(provider?.base_url).toBe(studio.baseUrl)
    expect(provider?.api_key).toBe(studio.apiKey)
    expect(
      provider?.settings.find((s) => s.key === 'base-url')?.controller_props
        .value
    ).toBe(studio.baseUrl)
    expect(
      provider?.settings.find((s) => s.key === 'api-key')?.controller_props
        .value
    ).toBe(studio.apiKey)
    expect(provider?.models.map((m) => m.id)).toEqual(['qwen3-8b', 'gemma-3'])
    // Once for the address, once more with the model ids to route by.
    expect(registry.register).toHaveBeenCalledTimes(2)
    expect(isAccountManagedProvider(provider)).toBe(true)
    expect(canDeleteProvider(provider)).toBe(false)
  })

  it('follows a new address and key, and leaves an unchanged one alone', async () => {
    await sync([studio])
    registry.register.mockClear()

    await sync([studio])
    expect(registry.register).not.toHaveBeenCalled()

    await sync([
      {
        ...studio,
        baseUrl: 'http://192.168.1.5:1337/v1',
        apiKey: 'sk-atomic-second',
      },
    ])
    const providers = useModelProvider.getState().providers
    expect(providers).toHaveLength(1)
    expect(providers[0].base_url).toBe('http://192.168.1.5:1337/v1')
    expect(providers[0].api_key).toBe('sk-atomic-second')
    expect(registry.register).toHaveBeenCalled()
  })

  it('never takes the name of a provider the user added', async () => {
    useModelProvider.getState().addProvider({
      provider: 'Studio Mac (remote)',
      active: true,
      models: [],
      settings: [],
      base_url: 'http://example.test/v1',
    })

    await sync([studio])

    expect(byName('Studio Mac (remote)')?.account_remote).toBeUndefined()
    expect(byName('Studio Mac (remote) 2')?.account_remote).toEqual({
      host_id: 'host-1',
    })
    expect(managedProviderName('Studio Mac', ['studio mac (REMOTE)'])).toBe(
      'Studio Mac (remote) 2'
    )
  })

  it('removes the provider once the access ends, and only that one', async () => {
    useModelProvider.getState().addProvider({
      provider: 'My vLLM',
      active: true,
      models: [],
      settings: [],
      base_url: 'http://10.0.0.2:8000/v1',
    })
    await sync([studio])

    await sync([])

    expect(byName('Studio Mac (remote)')).toBeUndefined()
    expect(byName('My vLLM')).toBeDefined()
    expect(registry.unregister).toHaveBeenCalledWith('Studio Mac (remote)')
  })

  it('keeps the provider when its computer cannot list models right now', async () => {
    fetchModels.mockRejectedValueOnce(new Error('offline'))

    await sync([studio])

    expect(byName('Studio Mac (remote)')?.models).toEqual([])
    // The next list tries again.
    await sync([studio])
    expect(byName('Studio Mac (remote)')?.models).toHaveLength(2)
  })

  it('lists the models again when asked, though the address and key are unchanged', async () => {
    // Connected while the host served nothing yet.
    fetchModels.mockResolvedValueOnce([])
    await sync([studio])
    expect(modelIds()).toEqual([])
    fetchModels.mockClear()
    registry.register.mockClear()

    await sync([studio], { refreshModels: true })

    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(modelIds()).toEqual(['qwen3-8b', 'gemma-3'])
    expect(registry.register).toHaveBeenCalledTimes(2)

    fetchModels.mockResolvedValueOnce(['llama-4'])
    await sync([studio])
    expect(modelIds()).toEqual(['qwen3-8b', 'gemma-3'])
    await sync([studio], { refreshModels: true })
    expect(modelIds()).toEqual(['llama-4'])
  })

  it('lists the models again for a newer address list at the same address', async () => {
    await sync([studio])
    fetchModels.mockClear()
    fetchModels.mockResolvedValueOnce(['llama-4'])

    await sync([{ ...studio, endpointsSeq: 2 }])

    expect(fetchModels).toHaveBeenCalledTimes(1)
    expect(modelIds()).toEqual(['llama-4'])
    expect(byName('Studio Mac (remote)')?.base_url).toBe(studio.baseUrl)

    // The same list again changes nothing.
    await sync([{ ...studio, endpointsSeq: 2 }])
    expect(fetchModels).toHaveBeenCalledTimes(1)
  })
})
