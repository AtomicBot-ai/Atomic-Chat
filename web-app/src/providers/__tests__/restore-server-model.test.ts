import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  ensureModelForServer: vi.fn(),
  server: { lastServerModels: [] as { model: string; provider: string }[], defaultModelLocalApiServer: null as { model: string; provider: string } | null },
}))

vi.mock('@/utils/ensureModelForServer', () => ({ ensureModelForServer: mocks.ensureModelForServer }))
vi.mock('@/hooks/useLocalApiServer', () => ({ useLocalApiServer: { getState: () => mocks.server } }))

import { restoreServerModelAfterRecovery } from '../DataProvider'

const modelsService = { getActiveModels: vi.fn(), stopModel: vi.fn(), startModel: vi.fn() }

describe('restoreServerModelAfterRecovery', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.server.lastServerModels = []
    mocks.server.defaultModelLocalApiServer = null
    mocks.ensureModelForServer.mockResolvedValue({ status: 'loaded', modelId: 'm', providerName: 'p' })
  })

  it('reloads the model the server was last started with', async () => {
    mocks.server.lastServerModels = [{ model: 'served', provider: 'llamacpp-upstream' }]
    mocks.server.defaultModelLocalApiServer = { model: 'default', provider: 'llamacpp-upstream' }

    await restoreServerModelAfterRecovery(modelsService)

    expect(mocks.ensureModelForServer).toHaveBeenCalledWith({
      modelsService,
      modelOverride: { model: 'served', provider: 'llamacpp-upstream' },
    })
  })

  it("falls back to the user's default server model, then to whatever Start server would pick", async () => {
    mocks.server.defaultModelLocalApiServer = { model: 'default', provider: 'mlx' }
    await restoreServerModelAfterRecovery(modelsService)
    expect(mocks.ensureModelForServer.mock.calls[0]?.[0].modelOverride).toEqual({ model: 'default', provider: 'mlx' })

    mocks.server.defaultModelLocalApiServer = null
    await restoreServerModelAfterRecovery(modelsService)
    expect(mocks.ensureModelForServer.mock.calls[1]?.[0].modelOverride).toBeNull()
  })

  it('does not throw when the load fails: the listener stays up either way', async () => {
    mocks.ensureModelForServer.mockRejectedValue(new Error('out of memory'))
    await expect(restoreServerModelAfterRecovery(modelsService)).resolves.toBeUndefined()
  })
})
