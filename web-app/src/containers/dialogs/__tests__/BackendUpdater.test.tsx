import { act, render, screen } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import BackendUpdater from '@/containers/dialogs/BackendUpdater'
import {
  resetImageGenerationForTests,
  useImageGenerationStore,
} from '@/stores/image-generation-store'
import { useUpdateBannerSlots } from '@/stores/update-banner-store'

const toast = vi.hoisted(() => ({ success: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))

// No llama.cpp transfer in these tests: the corner is the media engine's.
vi.mock('@/hooks/useBackendUpdater', () => ({
  useBackendUpdater: () => ({
    downloadState: {
      isDownloading: false,
      progress: 0,
      status: 'idle',
      backendName: null,
    },
    recommendation: null,
    recommendationPhase: 'idle',
    dismissRecommendation: vi.fn(),
    downloadRecommendedBackend: vi.fn(),
  }),
}))

const TARGET = 'master-900-abc1234'

const updating = (transferred: number, total: number) =>
  useImageGenerationStore.setState({
    engineUpdatingTo: TARGET,
    engineInstall: { inFlight: true, transferred, total, error: null },
    engineUpdate: {
      checking: false,
      availableTag: TARGET,
      checkedAt: 1,
      error: null,
    },
  })

describe('BackendUpdater — media engine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    resetImageGenerationForTests()
    useUpdateBannerSlots.setState({
      claimed: { download: false, app: false, engine: false },
    })
  })

  it('shows the media engine download in the corner while it runs', () => {
    updating(50, 200)
    render(<BackendUpdater />)

    expect(
      screen.getByText('settings:media.backgroundUpdateTitle')
    ).toBeInTheDocument()
    expect(screen.getByText(/25%/)).toBeInTheDocument()
  })

  it('says the update landed once the new build is installed', () => {
    updating(200, 200)
    render(<BackendUpdater />)

    act(() =>
      useImageGenerationStore.setState({
        engineUpdatingTo: null,
        engineInstall: {
          inFlight: false,
          transferred: 0,
          total: 0,
          error: null,
        },
        engineUpdate: {
          checking: false,
          availableTag: null,
          checkedAt: 2,
          error: null,
        },
      })
    )

    expect(toast.success).toHaveBeenCalledTimes(1)
    expect(toast.error).not.toHaveBeenCalled()
    expect(
      screen.queryByText('settings:media.backgroundUpdateTitle')
    ).not.toBeInTheDocument()
  })

  it('says the update failed when the offer is still standing', () => {
    updating(10, 200)
    render(<BackendUpdater />)

    act(() => useImageGenerationStore.setState({ engineUpdatingTo: null }))

    expect(toast.error).toHaveBeenCalledTimes(1)
    expect(toast.error.mock.calls[0]?.[0]).toBe('settings:media.updateFailed')
    expect(toast.success).not.toHaveBeenCalled()
  })
})
