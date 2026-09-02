import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { VOICE_MODEL_ID, VOICE_PROVIDER } from '@/constants/voice'
import { useAppState } from '@/hooks/useAppState'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import type { ModelsService } from '@/services/models/types'
import type { ProvidersService } from '@/services/providers/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('sonner', () => ({
  toast: { success: vi.fn(), error: vi.fn() },
}))

// Importing the registry store fires a background fetch that lands mid-test.
vi.mock('@/stores/provider-registry-store', () => ({
  useProviderRegistryStore: Object.assign(
    (selector?: (state: unknown) => unknown) => {
      const state = { providers: [], hasInitialized: true, refresh: vi.fn() }
      return selector ? selector(state) : state
    },
    {
      getState: () => ({
        providers: [],
        hasInitialized: true,
        refresh: vi.fn(),
      }),
    }
  ),
  isKnownProvider: () => true,
  ensureRegistryLoaded: async () => [],
}))

const releaseVoiceEngine = vi.fn()
vi.mock('@/lib/voice/engine', () => ({
  releaseVoiceEngine: () => releaseVoiceEngine(),
}))

const deleteModel = vi.fn()
const stopModel = vi.fn()
const pullModelWithMetadata = vi.fn()
const getProviders = vi.fn()

const upstream = (ids: string[]): ModelProvider =>
  ({
    active: true,
    provider: VOICE_PROVIDER,
    persist: true,
    settings: [],
    models: ids.map((id) => ({ id })),
  }) as ModelProvider

describe('useVoiceModel', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    releaseVoiceEngine.mockResolvedValue(undefined)
    deleteModel.mockResolvedValue(undefined)
    stopModel.mockResolvedValue(undefined)
    pullModelWithMetadata.mockResolvedValue(undefined)
    // The engine still lists the model on the refresh right after a delete.
    getProviders.mockResolvedValue([upstream([VOICE_MODEL_ID])])
    seedServiceHub({
      models: {
        deleteModel,
        stopModel,
        pullModelWithMetadata,
      } as unknown as ModelsService,
      providers: { getProviders } as unknown as ProvidersService,
    })
    useModelProvider.setState({
      providers: [upstream([VOICE_MODEL_ID])],
      deletedModels: [],
    })
    useFavoriteModel.setState({ favoriteModels: [] })
    useAppState.setState({ activeModels: [] })
  })

  it('stops reporting the model as installed once it is removed', async () => {
    const { result } = renderHook(() => useVoiceModel())
    expect(result.current.installed).toBe(true)

    await act(async () => {
      await result.current.remove()
    })

    expect(releaseVoiceEngine).toHaveBeenCalled()
    expect(deleteModel).toHaveBeenCalledWith(VOICE_MODEL_ID, VOICE_PROVIDER)
    expect(result.current.installed).toBe(false)
  })

  it('lifts the delete tombstone so a re-download can register again', async () => {
    const { result } = renderHook(() => useVoiceModel())

    await act(async () => {
      await result.current.remove()
    })
    expect(useModelProvider.getState().deletedModels).toContain(VOICE_MODEL_ID)

    await act(async () => {
      await result.current.download()
    })

    expect(pullModelWithMetadata).toHaveBeenCalled()
    expect(useModelProvider.getState().deletedModels).not.toContain(
      VOICE_MODEL_ID
    )

    // What the import handler does when the download lands.
    await act(async () => {
      useModelProvider.getState().setProviders([upstream([VOICE_MODEL_ID])])
    })
    expect(result.current.installed).toBe(true)
  })
})
