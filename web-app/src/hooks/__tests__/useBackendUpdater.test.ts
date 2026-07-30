import { renderHook, act } from '@testing-library/react'
import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import { events } from '@janhq/core'
import { useBackendUpdater } from '../useBackendUpdater'
import { localStorageKey } from '@/constants/localStorage'

const RECOMMENDED = 'b9937/win-cuda-13.3-x64'
const RECOMMENDATION = {
  currentBackend: 'b9800/win-cpu-x64',
  recommendedBackend: RECOMMENDED,
  recommendedCategory: 'CUDA',
}
const HOTSWAPPED_EVENT = 'app:backend-hotswapped'

const mocks = vi.hoisted(() => ({
  extension: null as Record<string, unknown> | null,
}))

// A minimal in-process bus, so the tests drive the hook the way the
// extension does: by emitting the real event names.
vi.mock('@janhq/core', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    events: {
      on: (name: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(handler)
      },
      off: (name: string, handler: (payload: unknown) => void) => {
        handlers.get(name)?.delete(handler)
      },
      emit: (name: string, payload?: unknown) => {
        handlers.get(name)?.forEach((handler) => handler(payload))
      },
    },
    AppEvent: {
      onBetterBackendDetected: 'onBetterBackendDetected',
      onBackendDownloadStarted: 'onBackendDownloadStarted',
      onBackendDownloadFinished: 'onBackendDownloadFinished',
    },
  }
})

vi.mock('@/lib/extension', () => ({
  ExtensionManager: {
    getInstance: () => ({
      getByName: () => mocks.extension,
      listExtensions: () => [],
    }),
  },
}))

describe('useBackendUpdater', () => {
  beforeEach(() => {
    localStorage.clear()
    mocks.extension = {
      downloadRecommendedBackend: vi.fn().mockResolvedValue(undefined),
      recheckOptimalBackend: vi.fn().mockResolvedValue(null),
    }
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  const detect = (payload: Record<string, unknown> = RECOMMENDATION) =>
    act(() => {
      events.emit('onBetterBackendDetected', payload)
    })

  const finishDownload = (
    status: 'completed' | 'failed',
    backend = RECOMMENDED
  ) =>
    act(() => {
      events.emit('onBackendDownloadFinished', { backend, status })
    })

  it('starts idle', () => {
    const { result } = renderHook(() => useBackendUpdater())

    expect(result.current.recommendationPhase).toBe('idle')
    expect(result.current.recommendation).toBeNull()
  })

  describe('surfacing a recommendation', () => {
    it('restores one the extension persisted before React mounted', () => {
      localStorage.setItem(
        'llama_cpp_better_backend_recommendation',
        JSON.stringify(RECOMMENDATION)
      )

      const { result } = renderHook(() => useBackendUpdater())

      expect(result.current.recommendationPhase).toBe('recommend')
      expect(result.current.recommendation).toEqual(RECOMMENDATION)
    })

    it('stays quiet once the user has finished setup', () => {
      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      localStorage.setItem(
        'llama_cpp_better_backend_recommendation',
        JSON.stringify(RECOMMENDATION)
      )

      const { result } = renderHook(() => useBackendUpdater())

      expect(result.current.recommendationPhase).toBe('idle')
    })

    it('accepts the detection event', () => {
      const { result } = renderHook(() => useBackendUpdater())

      detect()

      expect(result.current.recommendationPhase).toBe('recommend')
      expect(result.current.recommendation).toEqual(RECOMMENDATION)
    })

    it('ignores a recommendation belonging to the other provider', () => {
      const { result } = renderHook(() => useBackendUpdater())

      detect({ ...RECOMMENDATION, provider: 'llamacpp' })

      expect(result.current.recommendationPhase).toBe('idle')
      expect(result.current.recommendation).toBeNull()
    })
  })

  describe('the "Find optimal backend" button', () => {
    it('surfaces what the extension recommends', async () => {
      mocks.extension!.recheckOptimalBackend = vi
        .fn()
        .mockResolvedValue(RECOMMENDATION)

      const { result } = renderHook(() => useBackendUpdater())

      let recheckResult: unknown
      await act(async () => {
        recheckResult = await result.current.recheckOptimalBackend()
      })

      expect(recheckResult).toEqual(RECOMMENDATION)
      expect(result.current.recommendation).toEqual(RECOMMENDATION)
      expect(result.current.recommendationPhase).toBe('recommend')
    })

    it('stays idle when the host is already on the optimal backend', async () => {
      const { result } = renderHook(() => useBackendUpdater())

      let recheckResult: unknown
      await act(async () => {
        recheckResult = await result.current.recheckOptimalBackend()
      })

      expect(recheckResult).toBeNull()
      expect(result.current.recommendationPhase).toBe('idle')
    })

    it('downloads the backend passed explicitly, before state has committed', async () => {
      const { result } = renderHook(() => useBackendUpdater())

      // The settings button chains recheck → download in one tick, so the
      // hook's own `recommendation` state is still null at this point.
      await act(async () => {
        await result.current.downloadRecommendedBackend(RECOMMENDED)
      })

      expect(mocks.extension!.downloadRecommendedBackend).toHaveBeenCalledWith(
        RECOMMENDED
      )
      expect(result.current.recommendationPhase).toBe('downloading')
    })

    it('reverts to the prompt when the download call throws', async () => {
      mocks.extension!.downloadRecommendedBackend = vi
        .fn()
        .mockRejectedValue(new Error('asset 404'))

      const { result } = renderHook(() => useBackendUpdater())
      detect()

      await expect(
        act(async () => {
          await result.current.downloadRecommendedBackend()
        })
      ).rejects.toThrow('asset 404')

      expect(result.current.recommendationPhase).toBe('recommend')
    })
  })

  describe('download to hot-swap progression', () => {
    it('walks recommend → downloading → hotswapping → completed → idle', async () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useBackendUpdater())
      detect()

      act(() => {
        events.emit('onBackendDownloadStarted', {
          backend: RECOMMENDED,
          status: 'downloading',
        })
      })
      expect(result.current.recommendationPhase).toBe('downloading')
      expect(result.current.downloadState.isDownloading).toBe(true)

      finishDownload('completed')
      expect(result.current.recommendationPhase).toBe('hotswapping')

      act(() => {
        window.dispatchEvent(new Event(HOTSWAPPED_EVENT))
      })
      expect(result.current.recommendationPhase).toBe('completed')

      // The success state auto-dismisses.
      act(() => {
        vi.advanceTimersByTime(1500)
      })
      expect(result.current.recommendationPhase).toBe('idle')
      expect(result.current.recommendation).toBeNull()
    })

    it('asks for a restart when the hot-swap never reports back', () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useBackendUpdater())
      detect()
      finishDownload('completed')

      expect(result.current.recommendationPhase).toBe('hotswapping')

      act(() => {
        vi.advanceTimersByTime(8000)
      })

      expect(result.current.recommendationPhase).toBe('restart-required')
    })

    it('cancels the restart fallback once the hot-swap reports back', () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useBackendUpdater())
      detect()
      finishDownload('completed')

      act(() => {
        window.dispatchEvent(new Event(HOTSWAPPED_EVENT))
      })
      act(() => {
        vi.advanceTimersByTime(8000)
      })

      // Auto-dismissed to idle rather than hijacked into restart-required.
      expect(result.current.recommendationPhase).toBe('idle')
    })

    it('returns to the prompt when the download itself fails', () => {
      const { result } = renderHook(() => useBackendUpdater())
      detect()

      finishDownload('failed')

      expect(result.current.recommendationPhase).toBe('recommend')
      expect(result.current.downloadState.status).toBe('failed')
    })

    it('leaves a restart-required state alone when a stale event arrives', () => {
      vi.useFakeTimers()
      const { result } = renderHook(() => useBackendUpdater())
      detect()
      finishDownload('completed')
      act(() => {
        vi.advanceTimersByTime(8000)
      })
      expect(result.current.recommendationPhase).toBe('restart-required')

      detect()

      expect(result.current.recommendationPhase).toBe('restart-required')
    })
  })

  describe('manual "Latest <variant>" selection', () => {
    it('opens straight into the downloading state', () => {
      const { result } = renderHook(() => useBackendUpdater())

      act(() => {
        events.emit('onManualBackendDownloading', RECOMMENDATION)
      })

      expect(result.current.recommendationPhase).toBe('downloading')
      expect(result.current.recommendation).toEqual(RECOMMENDATION)
    })

    it('dismisses when the manual pick can be neither resolved nor installed', () => {
      const { result } = renderHook(() => useBackendUpdater())

      act(() => {
        events.emit('onManualBackendDownloading', RECOMMENDATION)
      })
      act(() => {
        events.emit('onManualBackendFailed', {})
      })

      expect(result.current.recommendationPhase).toBe('idle')
      expect(result.current.recommendation).toBeNull()
    })
  })
})
