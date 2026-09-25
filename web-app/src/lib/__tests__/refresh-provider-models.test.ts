import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  registry: { error: null as string | null, refresh: vi.fn() },
  toast: { success: vi.fn(), warning: vi.fn(), error: vi.fn() },
}))

vi.mock('sonner', () => ({ toast: mocks.toast }))
vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: { getState: () => mocks.registry },
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => ({ getProviderByName: () => undefined }) },
}))
vi.mock('@/lib/models', () => ({ getModelCapabilities: () => [] }))
vi.mock('@/utils/registerRemoteProvider', () => ({ isLocalProvider: () => false }))

import { refreshProviderModels } from '../refresh-provider-models'

const provider = {
  provider: 'my-vllm',
  base_url: 'http://127.0.0.1:8000/v1',
  models: [],
} as unknown as ProviderObject

const run = (liveIds: string[]) => {
  const updateProvider = vi.fn()
  const fetchModelsFromProvider = vi.fn().mockResolvedValue(liveIds)
  return refreshProviderModels({
    provider,
    serviceHub: {
      providers: () => ({ getProviders: async () => [], fetchModelsFromProvider }),
    } as never,
    setProviders: vi.fn(),
    updateProvider,
    t: (key) => key,
  }).then(() => ({ updateProvider, fetchModelsFromProvider }))
}

describe('refreshProviderModels with the registry unreachable', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.registry.error = 'registry unreachable'
  })

  it("still asks the provider's own endpoint and adds what it lists", async () => {
    const { updateProvider, fetchModelsFromProvider } = await run(['served-model'])

    expect(fetchModelsFromProvider).toHaveBeenCalledTimes(1)
    expect(updateProvider.mock.calls[0]?.[1].models.map((m: Model) => m.id)).toEqual([
      'served-model',
    ])
    expect(mocks.toast.success).toHaveBeenCalledTimes(1)
    expect(mocks.toast.error).not.toHaveBeenCalled()
  })

  it('says the registry could not be asked when nothing new turned up', async () => {
    await run([])

    expect(mocks.toast.warning.mock.calls[0]?.[1]).toEqual({
      description: 'registry unreachable',
    })
    expect(mocks.toast.success).not.toHaveBeenCalled()
  })
})
