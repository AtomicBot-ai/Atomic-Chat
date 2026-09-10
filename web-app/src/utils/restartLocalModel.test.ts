import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useModelProvider } from '@/hooks/useModelProvider'
import type { ModelsService } from '@/services/models/types'
import { createMockServiceHub } from '@/test/service-hub'
import { restartLocalModel } from '@/utils/restartLocalModel'

const syncActiveModelsFromEngines = vi.fn()

vi.mock('@/utils/activeModelsSync', () => ({
  syncActiveModelsFromEngines: (...args: unknown[]) =>
    syncActiveModelsFromEngines(...args),
}))

describe('restartLocalModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('waits for unload and reloads with the latest model settings', async () => {
    const calls: string[] = []
    const stopModel = vi.fn(async () => {
      calls.push('stop')
      return { success: true }
    })
    const startModel = vi.fn(async () => {
      calls.push('start')
      return undefined
    })
    const getActiveModels = vi.fn(async () => {
      calls.push('active')
      return ['test-model']
    })
    const model = {
      id: 'test-model',
      settings: {
        no_kv_offload: {
          controller_props: { value: true },
        },
      },
    } as Model
    const provider = {
      provider: 'llamacpp-upstream',
      models: [model],
    } as ModelProvider
    useModelProvider.setState({
      providers: [provider],
      selectedProvider: provider.provider,
      selectedModel: model,
    })
    const serviceHub = createMockServiceHub({
      models: {
        stopModel,
        startModel,
        getActiveModels,
      } as unknown as ModelsService,
    })

    await restartLocalModel(serviceHub, provider.provider, model.id)

    expect(calls).toEqual(['stop', 'start', 'active'])
    expect(stopModel).toHaveBeenCalledWith(model.id, provider.provider)
    expect(startModel).toHaveBeenCalledWith(provider, model.id, true)
    expect(syncActiveModelsFromEngines).toHaveBeenCalledWith([model.id])
  })

  it('does not start a second process when unload fails', async () => {
    const stopModel = vi.fn().mockResolvedValue({
      success: false,
      error: 'process did not stop',
    })
    const startModel = vi.fn()
    const serviceHub = createMockServiceHub({
      models: {
        stopModel,
        startModel,
      } as unknown as ModelsService,
    })

    await expect(
      restartLocalModel(serviceHub, 'llamacpp-upstream', 'test-model')
    ).rejects.toThrow('process did not stop')
    expect(startModel).not.toHaveBeenCalled()
  })
})
