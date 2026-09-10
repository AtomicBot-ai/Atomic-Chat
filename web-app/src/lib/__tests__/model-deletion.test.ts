import { beforeEach, describe, expect, it, vi } from 'vitest'

import { deleteLocalModel } from '../model-deletion'
import { createMockServiceHub } from '@/test/service-hub'
import { useAppState } from '@/hooks/useAppState'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import type { ServiceHub } from '@/services'

type ModelsService = ReturnType<ServiceHub['models']>
type ProvidersService = ReturnType<ServiceHub['providers']>

const provider = (name: string, ids: string[]): ModelProvider =>
  ({
    provider: name,
    active: true,
    models: ids.map((id) => ({ id, model: id })),
    settings: [],
  }) as unknown as ModelProvider

function setup(providers: ModelProvider[]) {
  const models = {
    stopModel: vi.fn().mockResolvedValue(undefined),
    deleteModel: vi.fn().mockResolvedValue(undefined),
  }
  const providersService = {
    getProviders: vi.fn().mockResolvedValue(providers),
  }
  const serviceHub = createMockServiceHub({
    models: models as unknown as ModelsService,
    providers: providersService as unknown as ProvidersService,
  })
  useModelProvider.setState({ providers, deletedModels: [] })
  return { serviceHub, models }
}

describe('deleteLocalModel', () => {
  beforeEach(() => {
    useAppState.setState({ activeModels: [] })
    useFavoriteModel.setState({ favoriteModels: [] })
  })

  it('removes a cloud model without asking an inference engine (#264)', async () => {
    const providers = [
      provider('openrouter', ['stealth/ox-alpha', 'z-ai/glm-5.3-flash']),
    ]
    const { serviceHub, models } = setup(providers)
    useFavoriteModel.getState().addFavorite(providers[0].models[0])

    await expect(
      deleteLocalModel(serviceHub, 'stealth/ox-alpha', 'openrouter')
    ).resolves.toBeUndefined()

    expect(models.deleteModel).not.toHaveBeenCalled()
    expect(models.stopModel).not.toHaveBeenCalled()

    const state = useModelProvider.getState()
    expect(state.providers[0].models.map((m) => m.id)).toEqual([
      'z-ai/glm-5.3-flash',
    ])
    expect(state.deletedModels).toContain('stealth/ox-alpha')
    expect(useFavoriteModel.getState().isFavorite('stealth/ox-alpha')).toBe(
      false
    )
  })

  it('skips the engine for a custom OpenAI-compatible endpoint too', async () => {
    const { serviceHub, models } = setup([
      provider('my-local-endpoint', ['qwen3']),
    ])

    await deleteLocalModel(serviceHub, 'qwen3', 'my-local-endpoint')

    expect(models.deleteModel).not.toHaveBeenCalled()
    expect(useModelProvider.getState().providers[0].models).toEqual([])
  })

  it('unloads and deletes through the engine for a local provider', async () => {
    const { serviceHub, models } = setup([provider('llamacpp', ['qwen3'])])
    useAppState.setState({ activeModels: ['qwen3'] })

    await deleteLocalModel(serviceHub, 'qwen3', 'llamacpp')

    expect(models.stopModel).toHaveBeenCalledWith('qwen3', 'llamacpp')
    expect(models.deleteModel).toHaveBeenCalledWith('qwen3', 'llamacpp')
    expect(useAppState.getState().activeModels).toEqual([])
    expect(useModelProvider.getState().providers[0].models).toEqual([])
  })

  it('leaves the store untouched when the local engine refuses', async () => {
    const { serviceHub, models } = setup([provider('llamacpp', ['qwen3'])])
    models.deleteModel.mockRejectedValue(new Error('missing model.yml'))

    await expect(
      deleteLocalModel(serviceHub, 'qwen3', 'llamacpp')
    ).rejects.toThrow('missing model.yml')

    expect(useModelProvider.getState().providers[0].models.map((m) => m.id))
      .toEqual(['qwen3'])
  })
})
