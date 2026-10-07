import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { EngineManager } from '@janhq/core'

import { usePrismEngine, type PrismEngineStatus } from '@/hooks/usePrismEngine'

const BUILD = 'prism-b10754-2459f68/macos-arm64'

/** The PrismML extension as the hook sees it. */
const extension = {
  getEngineStatus: vi.fn<() => Promise<PrismEngineStatus>>(),
  downloadRecommendedBackend: vi.fn<(backend: string) => Promise<void>>(),
}

/** `@janhq/core`'s event bus, which the extension's `settingsChanged` travels on. */
const handlers = new Map<string, Set<(payload: unknown) => void>>()
const emit = (name: string, payload: unknown) =>
  handlers.get(name)?.forEach((handler) => handler(payload))

const notInstalled = (recommended: string | null = BUILD) => ({
  installed: false,
  recommended,
})

describe('usePrismEngine', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    handlers.clear()
    vi.spyOn(EngineManager, 'instance').mockReturnValue({
      get: (name: string) => (name === 'atomic-prism' ? extension : undefined),
    } as unknown as EngineManager)
    const core = ((
      globalThis as unknown as { core?: Record<string, unknown> }
    ).core ??= {})
    core.events = {
      on: (name: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(handler)
      },
      off: (name: string, handler: (payload: unknown) => void) => {
        handlers.get(name)?.delete(handler)
      },
      emit,
    }
  })

  afterEach(() => vi.restoreAllMocks())

  it('reads the engine status from the extension', async () => {
    extension.getEngineStatus.mockResolvedValue(notInstalled())

    const { result } = renderHook(() => usePrismEngine(true))

    await waitFor(() => expect(result.current.status).toEqual(notInstalled()))
    expect(result.current.present).toBe(true)
  })

  it('asks nothing on another provider’s page', () => {
    const { result } = renderHook(() => usePrismEngine(false))

    expect(result.current.present).toBe(false)
    expect(extension.getEngineStatus.mock.calls).toEqual([])
  })

  it('installs the build the core recommends, then reads the status again', async () => {
    extension.getEngineStatus.mockResolvedValueOnce(notInstalled())
    extension.downloadRecommendedBackend.mockResolvedValue()
    const { result } = renderHook(() => usePrismEngine(true))
    await waitFor(() => expect(result.current.status).not.toBeNull())

    extension.getEngineStatus.mockResolvedValue({
      installed: true,
      recommended: BUILD,
    })
    await act(() => result.current.install())

    expect(extension.downloadRecommendedBackend.mock.calls).toEqual([[BUILD]])
    await waitFor(() => expect(result.current.status?.installed).toBe(true))
    expect(result.current.installing).toBe(false)
  })

  it('says why an install failed', async () => {
    extension.getEngineStatus.mockResolvedValue(notInstalled())
    extension.downloadRecommendedBackend.mockRejectedValue(
      new Error('disk full')
    )
    const { result } = renderHook(() => usePrismEngine(true))
    await waitFor(() => expect(result.current.status).not.toBeNull())

    await act(() => result.current.install())

    expect(result.current.installError).toBe('disk full')
    expect(result.current.installing).toBe(false)
  })

  it('asks again when the extension rebuilt its version list', async () => {
    extension.getEngineStatus.mockResolvedValueOnce(notInstalled(null))
    const { result } = renderHook(() => usePrismEngine(true))
    await waitFor(() =>
      expect(result.current.status).toEqual(notInstalled(null))
    )

    // "Allow unverified PrismML builds" turned on: the core now offers one.
    extension.getEngineStatus.mockResolvedValueOnce(notInstalled())
    act(() => emit('settingsChanged', { key: 'version_backend', value: BUILD }))

    await waitFor(() => expect(result.current.status).toEqual(notInstalled()))
  })

  it('keeps a failed check to show it, and checks again on demand', async () => {
    extension.getEngineStatus.mockRejectedValueOnce({
      message: 'core restarting',
    })
    const { result } = renderHook(() => usePrismEngine(true))
    await waitFor(() =>
      expect(result.current.checkError).toBe('core restarting')
    )

    extension.getEngineStatus.mockResolvedValueOnce(notInstalled())
    await act(() => result.current.check())

    expect(result.current.checkError).toBeNull()
    expect(result.current.status).toEqual(notInstalled())
  })
})
