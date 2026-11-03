import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { toast } from 'sonner'

import { VOICE_MODEL_ID, VOICE_PROVIDER } from '@/constants/voice'
import { useAppState } from '@/hooks/useAppState'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useVoiceModel } from '@/hooks/useVoiceModel'
import { clearDownloadCancellationRequested } from '@/lib/downloadCancellation'
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
const abortDownload = vi.fn()
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
    abortDownload.mockResolvedValue(undefined)
    clearDownloadCancellationRequested(VOICE_MODEL_ID)
    useDownloadStore.setState({
      localDownloadingModels: new Set(),
      resumableDownloads: new Set(),
    })
    // The engine still lists the model on the refresh right after a delete.
    getProviders.mockResolvedValue([upstream([VOICE_MODEL_ID])])
    seedServiceHub({
      models: {
        deleteModel,
        stopModel,
        pullModelWithMetadata,
        abortDownload,
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

  describe('download cancel', () => {
    it('does not report a cancelled download as a failure', async () => {
      // The pull rejects with the downloader's own cancel error the moment the
      // user presses Cancel; the download listener already says "cancelled".
      pullModelWithMetadata.mockRejectedValueOnce('Download cancelled')
      const { result } = renderHook(() => useVoiceModel())

      await act(async () => {
        result.current.cancelDownload()
        await result.current.download()
      })

      expect(abortDownload).toHaveBeenCalledWith(VOICE_MODEL_ID)
      expect(toast.error).not.toHaveBeenCalled()
      const store = useDownloadStore.getState()
      expect(store.localDownloadingModels.has(VOICE_MODEL_ID)).toBe(false)
      expect(store.resumableDownloads.has(VOICE_MODEL_ID)).toBe(true)
    })

    it('stays quiet when the stop event has already cleared the cancel request', async () => {
      // The global stop listener runs first and forgets the request, so only
      // the rejection itself says it was a cancel.
      pullModelWithMetadata.mockRejectedValueOnce('Download cancelled')
      const { result } = renderHook(() => useVoiceModel())

      await act(async () => {
        await result.current.download()
      })

      expect(toast.error).not.toHaveBeenCalled()
      expect(
        useDownloadStore.getState().localDownloadingModels.has(VOICE_MODEL_ID)
      ).toBe(false)
    })

    it('still reports a download that really failed', async () => {
      pullModelWithMetadata.mockRejectedValueOnce(new Error('HTTP status 500'))
      const { result } = renderHook(() => useVoiceModel())

      await act(async () => {
        await result.current.download()
      })

      expect(toast.error).toHaveBeenCalledWith(
        'common:voiceInput.setup.model.failed',
        { description: 'HTTP status 500' }
      )
      expect(
        useDownloadStore.getState().localDownloadingModels.has(VOICE_MODEL_ID)
      ).toBe(false)
    })
  })
})
