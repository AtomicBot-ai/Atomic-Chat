import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { initializeServiceHubStore } from '@/hooks/useServiceHub'
import { createMockServiceHub } from '@/test/service-hub'

const { toastInfo, toastWarning, toastError, toastDismiss, setRunning } = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  setRunning: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { info: toastInfo, warning: toastWarning, error: toastError, dismiss: toastDismiss },
}))
vi.mock('@/utils/localApiServerControl', () => ({
  setLocalApiServerRunning: setRunning,
  stopLocalApiServer: vi.fn(),
}))
vi.mock('@/utils/activeModelsSync', () => ({
  hydrateActiveModelsForRunningServer: vi.fn(),
  syncActiveModelsFromEngines: vi.fn(),
}))

import { useLocalApiServerControl } from '../useLocalApiServerControl'

/** The port the core actually bound, as the store learns it while the server starts. */
function bindsPort(port: number): void {
  setRunning.mockImplementation(async () => {
    useLocalApiServer.getState().setServerPort(port)
  })
}

describe('starting the local API server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLocalApiServer.getState().setServerPort(1337)
    initializeServiceHubStore(
      createMockServiceHub({
        app: { getServerStatus: vi.fn().mockResolvedValue(false) } as never,
      })
    )
  })

  // The core takes a free port when the configured one is busy — another Atomic Chat, Ollama,
  // anything. The store follows it, so the app works; the user's own clients do not, because they
  // are pointed at the port the user set. Silence there is a refused connection with no cause.
  it('says so when the core had to bind a different port', async () => {
    bindsPort(1338)
    const { result } = renderHook(() => useLocalApiServerControl())
    // The mount effect asks the app service whether a server is already running.
    await act(async () => {})

    await act(async () => {
      await result.current.start({ ensureModel: false })
    })

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1))
    const [title, options] = toastWarning.mock.calls[0] as [string, { description: string }]
    expect(title).toBe('Server started on a different port')
    expect(options.description).toContain('1337')
    expect(options.description).toContain('1338')
  })

  it('stays quiet when the configured port was free', async () => {
    bindsPort(1337)
    const { result } = renderHook(() => useLocalApiServerControl())
    // The mount effect asks the app service whether a server is already running.
    await act(async () => {})

    await act(async () => {
      await result.current.start({ ensureModel: false })
    })

    expect(setRunning).toHaveBeenCalledWith(true)
    expect(toastWarning).not.toHaveBeenCalled()
  })
})
