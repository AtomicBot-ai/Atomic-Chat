import { act, cleanup, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useRemoteAccessStore } from '@/hooks/useRemoteAccess'
import { seedServiceHub } from '@/test/service-hub'
import {
  REMOTE_ACCESS_STATUS_EVENT,
  type RemoteAccessStatus,
} from '@/types/remoteAccess'

const { capture, toastError, features } = vi.hoisted(() => ({
  capture: vi.fn(),
  toastError: vi.fn(),
  features: { localApiServer: true } as Record<string, boolean>,
}))

vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: capture }))

vi.mock('sonner', () => ({
  toast: { error: toastError, success: vi.fn(), info: vi.fn() },
}))

vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({ t: (key: string) => key }),
}))

vi.mock('@/lib/platform/const', () => ({ PlatformFeatures: features }))

import { useRemoteAccessSync } from '../useRemoteAccessSync'

const OFF: RemoteAccessStatus = {
  state: 'off',
  url: null,
  error: null,
  blockReason: null,
  canStart: true,
  canStop: false,
  serverHasApiKey: true,
}

const STARTING: RemoteAccessStatus = {
  ...OFF,
  state: 'starting',
  canStart: false,
  canStop: true,
}

const ONLINE: RemoteAccessStatus = {
  ...STARTING,
  state: 'online',
  url: 'https://quiet-river.trycloudflare.com',
}

type StatusHandler = (event: { payload: unknown }) => void

function deferred<T>() {
  let resolve!: (value: T) => void
  let reject!: (reason: unknown) => void
  const promise = new Promise<T>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

function mountHub() {
  const handlers = new Map<string, StatusHandler>()
  const unlisten = vi.fn()
  const app = {
    getRemoteAccessStatus: vi.fn().mockResolvedValue(OFF),
    startRemoteAccess: vi.fn().mockResolvedValue(STARTING),
    stopRemoteAccess: vi.fn().mockResolvedValue(OFF),
    getLanAddresses: vi.fn().mockResolvedValue([]),
  }
  const events = {
    emit: vi.fn(),
    listen: vi.fn(async (name: string, handler: StatusHandler) => {
      handlers.set(name, handler)
      return unlisten
    }),
  }
  seedServiceHub({ app: app as never, events: events as never })
  return {
    app,
    events,
    unlisten,
    /** Delivers a `remote-access:status` event the way Tauri would. */
    emitStatus: (payload: unknown) => {
      const handler = handlers.get(REMOTE_ACCESS_STATUS_EVENT)
      if (!handler) throw new Error('the hook never subscribed')
      act(() => handler({ payload }))
    },
  }
}

const tunnel = () => useRemoteAccessStore.getState()

const setServerStatus = (value: 'running' | 'stopped' | 'pending') =>
  act(() => useAppState.getState().setServerStatus(value))

/** Lets the transition effect's re-read and whatever follows it settle. */
async function settled(
  app: ReturnType<typeof mountHub>['app'],
  statusReads: number
) {
  await waitFor(() =>
    expect(app.getRemoteAccessStatus).toHaveBeenCalledTimes(statusReads)
  )
  await act(async () => {})
}

describe('useRemoteAccessSync', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    features.localApiServer = true
    localStorage.clear()
    useRemoteAccessStore.getState().reset()
    useAppState.setState({ serverStatus: 'stopped' })
    useLocalApiServer.setState({
      apiKey: '',
      remoteAccessAutoStart: false,
      exposeWithoutKeyAcknowledged: false,
    })
  })

  // The shared teardown clears the service hub before it unmounts; a hook that
  // is still mounted then re-renders outside `act`. Unmount first.
  afterEach(() => {
    cleanup()
  })

  it('fills the store from the first status read', async () => {
    const { app, events } = mountHub()
    app.getRemoteAccessStatus.mockResolvedValue(ONLINE)

    renderHook(() => useRemoteAccessSync())

    await waitFor(() => expect(tunnel().status).toEqual(ONLINE))
    expect(tunnel().unavailable).toBe(false)
    expect(events.listen).toHaveBeenCalledWith(
      REMOTE_ACCESS_STATUS_EVENT,
      expect.any(Function)
    )
  })

  it('follows the status event: the URL arrives seconds after Start', async () => {
    const { emitStatus } = mountHub()
    renderHook(() => useRemoteAccessSync())
    await waitFor(() => expect(tunnel().status).toEqual(OFF))

    emitStatus(STARTING)
    expect(tunnel().status?.state).toBe('starting')
    expect(tunnel().status?.url).toBeNull()

    emitStatus(ONLINE)
    expect(tunnel().status?.state).toBe('online')
    expect(tunnel().status?.url).toBe('https://quiet-river.trycloudflare.com')
  })

  it('reads a snake_case payload and ignores one that is not a status', async () => {
    const { emitStatus } = mountHub()
    renderHook(() => useRemoteAccessSync())
    await waitFor(() => expect(tunnel().status).toEqual(OFF))

    emitStatus({
      state: 'error',
      error: 'not_reachable',
      block_reason: null,
      can_start: true,
      can_stop: false,
      server_has_api_key: false,
    })
    expect(tunnel().status).toEqual({
      ...OFF,
      state: 'error',
      error: 'not_reachable',
      serverHasApiKey: false,
    })

    emitStatus({ hello: 'world' })
    expect(tunnel().status?.state).toBe('error')
  })

  it('reports how long the tunnel took once it leaves `starting`', async () => {
    const { emitStatus } = mountHub()
    renderHook(() => useRemoteAccessSync())
    await waitFor(() => expect(tunnel().status).toEqual(OFF))

    emitStatus(STARTING)
    emitStatus(ONLINE)

    const outcome = capture.mock.calls.find(
      ([event]) => event === 'remote_access_outcome'
    )
    expect(outcome?.[1]).toEqual({
      outcome: 'online',
      wait_ms: expect.any(Number),
    })
    // The URL identifies the machine: it must never ride along.
    expect(JSON.stringify(capture.mock.calls)).not.toContain('trycloudflare')
  })

  it('marks remote access unavailable when the status command is missing', async () => {
    const { app } = mountHub()
    app.getRemoteAccessStatus.mockRejectedValue(
      'Command get_remote_access_status not found'
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    renderHook(() => useRemoteAccessSync())

    await waitFor(() => expect(tunnel().unavailable).toBe(true))
    expect(tunnel().status).toBeNull()
    warn.mockRestore()
  })

  it('does not let a slow status read repaint over a newer event', async () => {
    const { app, emitStatus } = mountHub()
    const slowRead = deferred<RemoteAccessStatus>()
    app.getRemoteAccessStatus.mockReturnValue(slowRead.promise)

    renderHook(() => useRemoteAccessSync())
    await waitFor(() => expect(app.getRemoteAccessStatus).toHaveBeenCalled())
    // `listen` resolves on a microtask; let the subscription attach.
    await act(async () => {})

    emitStatus(ONLINE)
    await act(async () => {
      slowRead.resolve(OFF)
      await slowRead.promise
    })

    expect(tunnel().status).toEqual(ONLINE)
  })

  it('re-reads the status when the window regains focus', async () => {
    const { app } = mountHub()
    renderHook(() => useRemoteAccessSync())
    await waitFor(() => expect(tunnel().status).toEqual(OFF))

    app.getRemoteAccessStatus.mockResolvedValue(ONLINE)
    act(() => {
      window.dispatchEvent(new Event('focus'))
    })

    await waitFor(() => expect(tunnel().status).toEqual(ONLINE))
    expect(app.getRemoteAccessStatus).toHaveBeenCalledTimes(2)
  })

  it('detaches from the event and the window on unmount', async () => {
    const { app, unlisten } = mountHub()
    const { unmount } = renderHook(() => useRemoteAccessSync())
    await waitFor(() => expect(tunnel().status).toEqual(OFF))

    unmount()
    window.dispatchEvent(new Event('focus'))

    expect(unlisten).toHaveBeenCalledTimes(1)
    expect(app.getRemoteAccessStatus).toHaveBeenCalledTimes(1)
    expect(tunnel().status).toEqual(OFF)
  })

  describe('starting the tunnel with the server', () => {
    it('asks for a tunnel when the server comes up, with auto-start on and a key set', async () => {
      const { app } = mountHub()
      useLocalApiServer.setState({
        remoteAccessAutoStart: true,
        apiKey: 'sk-atomic-key',
      })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(OFF))

      setServerStatus('pending')
      setServerStatus('running')

      await waitFor(() => expect(tunnel().status?.state).toBe('starting'))
      expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
      expect(capture).toHaveBeenCalledWith('remote_access_start', {
        trigger_source: 'auto',
        start_result: 'started',
      })
      expect(toastError).not.toHaveBeenCalled()
    })

    it('stays off without a key until the user has agreed to that', async () => {
      const { app } = mountHub()
      useLocalApiServer.setState({ remoteAccessAutoStart: true, apiKey: '  ' })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(OFF))

      setServerStatus('running')
      await settled(app, 2)

      expect(app.startRemoteAccess).not.toHaveBeenCalled()
      expect(tunnel().status?.state).toBe('off')
    })

    it('starts without a key once that was acknowledged on the page', async () => {
      const { app } = mountHub()
      useLocalApiServer.setState({
        remoteAccessAutoStart: true,
        apiKey: '',
        exposeWithoutKeyAcknowledged: true,
      })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(OFF))

      setServerStatus('running')

      await waitFor(() => expect(tunnel().status?.state).toBe('starting'))
      expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
    })

    it('leaves the tunnel alone with auto-start off', async () => {
      const { app } = mountHub()
      useLocalApiServer.setState({ apiKey: 'sk-atomic-key' })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(OFF))

      setServerStatus('running')
      await settled(app, 2)

      expect(app.startRemoteAccess).not.toHaveBeenCalled()
      expect(tunnel().status?.state).toBe('off')
    })

    it('does not start a second tunnel next to one that is already up', async () => {
      const { app } = mountHub()
      app.getRemoteAccessStatus.mockResolvedValue(ONLINE)
      useLocalApiServer.setState({
        remoteAccessAutoStart: true,
        apiKey: 'sk-atomic-key',
      })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(ONLINE))

      setServerStatus('running')
      await settled(app, 2)

      expect(app.startRemoteAccess).not.toHaveBeenCalled()
      expect(tunnel().status).toEqual(ONLINE)
    })

    it('tries again after an error, the next time the server comes up', async () => {
      const { app } = mountHub()
      app.getRemoteAccessStatus.mockResolvedValue({
        ...OFF,
        state: 'error',
        error: 'exited',
      })
      useLocalApiServer.setState({
        remoteAccessAutoStart: true,
        apiKey: 'sk-atomic-key',
      })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status?.state).toBe('error'))

      setServerStatus('running')

      await waitFor(() => expect(tunnel().status?.state).toBe('starting'))
      expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
    })

    it('re-reads the status when the server stops, and starts nothing', async () => {
      const { app } = mountHub()
      useAppState.setState({ serverStatus: 'running' })
      useLocalApiServer.setState({
        remoteAccessAutoStart: true,
        apiKey: 'sk-atomic-key',
      })
      app.getRemoteAccessStatus.mockResolvedValue(ONLINE)
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(ONLINE))

      // Rust drops the tunnel together with the server.
      const stopped = { ...OFF, blockReason: 'server_stopped' as const }
      app.getRemoteAccessStatus.mockResolvedValue(stopped)
      setServerStatus('stopped')

      await waitFor(() => expect(tunnel().status).toEqual(stopped))
      expect(app.startRemoteAccess).not.toHaveBeenCalled()
    })

    it('says so when the automatic start is refused', async () => {
      const { app } = mountHub()
      app.startRemoteAccess.mockRejectedValue('cloudflared_unavailable')
      useLocalApiServer.setState({
        remoteAccessAutoStart: true,
        apiKey: 'sk-atomic-key',
      })
      renderHook(() => useRemoteAccessSync())
      await waitFor(() => expect(tunnel().status).toEqual(OFF))

      setServerStatus('running')

      await waitFor(() =>
        expect(toastError).toHaveBeenCalledWith(
          'settings:remoteLan.remote.autoStartFailed'
        )
      )
      expect(tunnel().lastError).toEqual({
        kind: 'failed',
        code: 'cloudflared_unavailable',
      })
      expect(capture).toHaveBeenCalledWith('remote_access_start', {
        trigger_source: 'auto',
        start_result: 'failed',
        failure_code: 'cloudflared_unavailable',
      })
    })
  })

  it('does nothing where there is no Local API Server', async () => {
    features.localApiServer = false
    const { app, events } = mountHub()
    useLocalApiServer.setState({
      remoteAccessAutoStart: true,
      apiKey: 'sk-atomic-key',
    })

    renderHook(() => useRemoteAccessSync())
    setServerStatus('running')
    await act(async () => {})

    expect(events.listen).not.toHaveBeenCalled()
    expect(app.getRemoteAccessStatus).not.toHaveBeenCalled()
    expect(app.startRemoteAccess).not.toHaveBeenCalled()
    expect(tunnel().status).toBeNull()
  })
})
