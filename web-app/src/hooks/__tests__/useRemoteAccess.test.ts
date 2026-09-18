import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { createMockServiceHub } from '@/test/service-hub'
import type { RemoteAccessStatus } from '@/types/remoteAccess'

const { capture } = vi.hoisted(() => ({ capture: vi.fn() }))

vi.mock('@/lib/telemetry-queue', () => ({ queuedCapture: capture }))

import {
  refreshRemoteAccessStatus,
  restartLocalApiServer,
  startLocalApiServerAndSettle,
  startRemoteAccess,
  stopRemoteAccess,
  useRemoteAccessStore,
} from '../useRemoteAccess'

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

/** What the relay rejects with when the core did not answer. */
const CORE_UNREACHABLE = {
  code: 'CORE_UNREACHABLE',
  message: 'The Atomic Chat core did not answer.',
}

function deferred<T>() {
  let resolve!: (value: T) => void
  const promise = new Promise<T>((res) => {
    resolve = res
  })
  return { promise, resolve }
}

function makeHub() {
  const app = {
    getRemoteAccessStatus: vi.fn().mockResolvedValue(OFF),
    startRemoteAccess: vi.fn().mockResolvedValue(STARTING),
    stopRemoteAccess: vi.fn().mockResolvedValue(OFF),
  }
  return { app, hub: createMockServiceHub({ app: app as never }) }
}

const tunnel = () => useRemoteAccessStore.getState()
const eventsNamed = (name: string) =>
  capture.mock.calls.filter(([event]) => event === name).map(([, props]) => props)

describe('useRemoteAccessStore.applyStatus', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tunnel().reset()
  })

  it('takes events and command results, and counts them', () => {
    tunnel().applyStatus(STARTING, 'mutation')
    tunnel().applyStatus(ONLINE, 'event')

    expect(tunnel().status).toEqual(ONLINE)
    expect(tunnel().revision).toBe(2)
  })

  it('takes a status read without counting it', () => {
    tunnel().applyStatus(OFF, 'fetch', 0)

    expect(tunnel().status).toEqual(OFF)
    expect(tunnel().revision).toBe(0)
  })

  it('drops a read, or a command result, that an event has overtaken', () => {
    const requestedAt = tunnel().revision
    tunnel().applyStatus(ONLINE, 'event')

    tunnel().applyStatus(OFF, 'fetch', requestedAt)
    expect(tunnel().status).toEqual(ONLINE)

    tunnel().applyStatus(STARTING, 'mutation', requestedAt)
    expect(tunnel().status).toEqual(ONLINE)
  })

  it('never drops an event', () => {
    tunnel().applyStatus(ONLINE, 'event')
    tunnel().applyStatus(OFF, 'event', 0)

    expect(tunnel().status).toEqual(OFF)
  })

  it('clears `unavailable` as soon as any status arrives', () => {
    useRemoteAccessStore.setState({ unavailable: true })

    tunnel().applyStatus(OFF, 'event')

    expect(tunnel().unavailable).toBe(false)
  })

  it('reports the wait and the code when a start ends in an error', () => {
    vi.useFakeTimers()
    try {
      vi.setSystemTime(1_000_000)
      tunnel().applyStatus(STARTING, 'event')
      vi.setSystemTime(1_012_500)
      // A repeated `starting` must not restart the clock.
      tunnel().applyStatus(STARTING, 'mutation')
      vi.setSystemTime(1_015_000)
      tunnel().applyStatus(
        { ...OFF, state: 'error', error: 'not_registered' },
        'event'
      )
    } finally {
      vi.useRealTimers()
    }

    expect(eventsNamed('remote_access_outcome')).toEqual([
      { outcome: 'error', wait_ms: 15_000, failure_code: 'not_registered' },
    ])
    expect(tunnel().startedAt).toBeNull()
  })

  it('keeps free-form error text out of telemetry', () => {
    tunnel().applyStatus(STARTING, 'event')
    tunnel().applyStatus(
      {
        ...OFF,
        state: 'error',
        error: 'probe to quiet-river.trycloudflare.com timed out',
      },
      'event'
    )

    expect(eventsNamed('remote_access_outcome')).toEqual([
      { outcome: 'error', wait_ms: expect.any(Number), failure_code: 'unknown' },
    ])
  })

  it('reports no outcome for a start the user called off', () => {
    tunnel().applyStatus(STARTING, 'event')
    tunnel().applyStatus({ ...STARTING, state: 'stopping' }, 'event')
    tunnel().applyStatus(OFF, 'event')

    expect(eventsNamed('remote_access_outcome')).toEqual([])
    expect(tunnel().status).toEqual(OFF)
  })

  it('forgets the last refusal once the tunnel moves on, not before', () => {
    tunnel().applyStatus(OFF, 'event')
    useRemoteAccessStore.setState({
      lastError: { kind: 'failed', code: 'cloudflared_unavailable' },
    })

    tunnel().applyStatus(OFF, 'fetch')
    expect(tunnel().lastError).toEqual({
      kind: 'failed',
      code: 'cloudflared_unavailable',
    })

    tunnel().applyStatus(STARTING, 'event')
    expect(tunnel().lastError).toBeNull()
  })
})

describe('remote access actions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    tunnel().reset()
  })

  it('refreshes from the status command', async () => {
    const { app, hub } = makeHub()
    app.getRemoteAccessStatus.mockResolvedValue(ONLINE)

    await refreshRemoteAccessStatus(hub)

    expect(tunnel().status).toEqual(ONLINE)
  })

  it('keeps a failed refresh from hiding an event that arrived meanwhile', async () => {
    const { app, hub } = makeHub()
    const read = deferred<RemoteAccessStatus>()
    app.getRemoteAccessStatus.mockReturnValue(
      read.promise.then(() => Promise.reject('boom'))
    )
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    const refreshing = refreshRemoteAccessStatus(hub)
    tunnel().applyStatus(ONLINE, 'event')
    read.resolve(OFF)
    await refreshing

    expect(tunnel().unavailable).toBe(false)
    expect(tunnel().status).toEqual(ONLINE)
    warn.mockRestore()
  })

  it('keeps the last status through a core that did not answer', async () => {
    const { app, hub } = makeHub()
    // The server is still up, so the tunnel in front of it may be too.
    useAppState.setState({ serverStatus: 'running' })
    tunnel().applyStatus(ONLINE, 'event')
    app.getRemoteAccessStatus.mockRejectedValue(CORE_UNREACHABLE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshRemoteAccessStatus(hub)

    expect(tunnel().unavailable).toBe(false)
    expect(tunnel().status).toEqual(ONLINE)
    expect(warn).toHaveBeenCalled()
    warn.mockRestore()
  })

  it.each([
    ['starting', STARTING],
    ['online', ONLINE],
    ['stopping', { ...ONLINE, state: 'stopping' } as RemoteAccessStatus],
  ])(
    'forgets a tunnel kept as %s once the core is down and the server with it',
    async (_label, kept) => {
      const { app, hub } = makeHub()
      tunnel().applyStatus(kept, 'event')
      // The core died with the server in it and will not be started again.
      useAppState.setState({ serverStatus: 'stopped' })
      app.getRemoteAccessStatus.mockRejectedValue({
        code: 'CORE_START_FAILED',
        message: 'The Atomic Chat core keeps stopping.',
      })
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

      await refreshRemoteAccessStatus(hub)

      // Unknown, not a dead URL and not "not in this build".
      expect(tunnel().status).toBeNull()
      expect(tunnel().startedAt).toBeNull()
      expect(tunnel().unavailable).toBe(false)
      warn.mockRestore()
    }
  )

  it('keeps a tunnel that is off through the same outage', async () => {
    const { app, hub } = makeHub()
    const stopped: RemoteAccessStatus = {
      ...OFF,
      blockReason: 'server_stopped',
      canStart: false,
    }
    tunnel().applyStatus(stopped, 'event')
    useAppState.setState({ serverStatus: 'stopped' })
    app.getRemoteAccessStatus.mockRejectedValue(CORE_UNREACHABLE)
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshRemoteAccessStatus(hub)

    expect(tunnel().status).toEqual(stopped)
    expect(tunnel().unavailable).toBe(false)
    warn.mockRestore()
  })

  it('stays unknown, not unavailable, when the core is down before the first status', async () => {
    const { app, hub } = makeHub()
    app.getRemoteAccessStatus.mockRejectedValue({
      code: 'CORE_START_FAILED',
      message: 'The Atomic Chat core keeps stopping.',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshRemoteAccessStatus(hub)

    expect(tunnel().unavailable).toBe(false)
    expect(tunnel().status).toBeNull()
    warn.mockRestore()
  })

  it('reports remote access unavailable for a reply that is not a status', async () => {
    const { app, hub } = makeHub()
    // What `services/app/tauri.ts` rejects with for such a reply.
    app.getRemoteAccessStatus.mockRejectedValue(new Error('malformed_status'))
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshRemoteAccessStatus(hub)

    expect(tunnel().unavailable).toBe(true)
    warn.mockRestore()
  })

  it('takes a core without the route for a failed call, not a missing feature', async () => {
    const { app, hub } = makeHub()
    // What the core answers (404) for a control route it does not serve.
    app.getRemoteAccessStatus.mockRejectedValue({
      code: 'INVALID_ARGUMENT',
      message: 'No such control route: /atomic/v1/remote-access',
    })
    const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})

    await refreshRemoteAccessStatus(hub)

    expect(tunnel().unavailable).toBe(false)
    expect(tunnel().status).toBeNull()
    warn.mockRestore()
  })

  it('starts the tunnel and says who asked', async () => {
    const { app, hub } = makeHub()

    await expect(startRemoteAccess(hub, 'manual')).resolves.toBe(true)

    expect(tunnel().status).toEqual(STARTING)
    expect(tunnel().busy).toBeNull()
    expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
    expect(eventsNamed('remote_access_start')).toEqual([
      { trigger_source: 'manual', start_result: 'started' },
    ])
  })

  it('is busy while the command is in flight, and starts once for two callers', async () => {
    const { app, hub } = makeHub()
    const command = deferred<RemoteAccessStatus>()
    app.startRemoteAccess.mockReturnValue(command.promise)

    const fromButton = startRemoteAccess(hub, 'manual')
    expect(tunnel().busy).toBe('start')
    const fromAutoStart = startRemoteAccess(hub, 'auto')
    command.resolve(STARTING)

    await expect(fromButton).resolves.toBe(true)
    await expect(fromAutoStart).resolves.toBe(true)
    expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
    expect(eventsNamed('remote_access_start')).toHaveLength(1)
  })

  it.each(['starting', 'online'] as const)(
    'does not ask again while the tunnel is %s',
    async (state) => {
      const { app, hub } = makeHub()
      tunnel().applyStatus({ ...ONLINE, state }, 'event')

      await expect(startRemoteAccess(hub, 'restore')).resolves.toBe(true)

      expect(app.startRemoteAccess).not.toHaveBeenCalled()
      expect(tunnel().status?.state).toBe(state)
    }
  )

  it('records a refusal, reports it, and re-reads the status', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(OFF, 'event')
    app.startRemoteAccess.mockRejectedValue('server_stopped')
    const stopped = { ...OFF, blockReason: 'server_stopped' as const }
    app.getRemoteAccessStatus.mockResolvedValue(stopped)

    await expect(startRemoteAccess(hub, 'manual')).resolves.toBe(false)

    expect(tunnel().lastError).toEqual({
      kind: 'blocked',
      blockReason: 'server_stopped',
    })
    expect(tunnel().status).toEqual(stopped)
    expect(tunnel().busy).toBeNull()
    expect(eventsNamed('remote_access_start')).toEqual([
      {
        trigger_source: 'manual',
        start_result: 'blocked',
        block_reason: 'server_stopped',
      },
    ])
  })

  it('reports a start the core did not answer by its code, not its message', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(OFF, 'event')
    // A POST is not retried, so this one fails even if the read after it
    // reaches a relaunched core.
    app.startRemoteAccess.mockRejectedValue(CORE_UNREACHABLE)

    await expect(startRemoteAccess(hub, 'auto')).resolves.toBe(false)

    expect(tunnel().lastError).toEqual({
      kind: 'failed',
      code: 'core_unreachable',
    })
    expect(tunnel().unavailable).toBe(false)
    expect(eventsNamed('remote_access_start')).toEqual([
      {
        trigger_source: 'auto',
        start_result: 'failed',
        failure_code: 'core_unreachable',
      },
    ])
    expect(JSON.stringify(capture.mock.calls)).not.toContain('Atomic Chat')
  })

  it('stops the tunnel', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(ONLINE, 'event')

    await expect(stopRemoteAccess(hub)).resolves.toBe(true)

    expect(app.stopRemoteAccess).toHaveBeenCalledTimes(1)
    expect(tunnel().status).toEqual(OFF)
    expect(eventsNamed('remote_access_stop')).toEqual([
      { stop_result: 'stopped' },
    ])
  })

  it('reports a stop that the core could not confirm', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(ONLINE, 'event')
    const stuck: RemoteAccessStatus = {
      ...ONLINE,
      state: 'error',
      error: 'stop_failed',
      canStart: false,
      canStop: true,
    }
    app.stopRemoteAccess.mockResolvedValue(stuck)

    await expect(stopRemoteAccess(hub)).resolves.toBe(false)

    expect(tunnel().status).toEqual(stuck)
    expect(eventsNamed('remote_access_stop')).toEqual([
      { stop_result: 'failed', failure_code: 'stop_failed' },
    ])
  })
})

describe('startLocalApiServerAndSettle', () => {
  beforeEach(() => {
    useAppState.setState({ serverStatus: 'stopped' })
  })

  it('resolves true once the server is up, passing the options through', async () => {
    const start = vi.fn(async () => {
      useAppState.getState().setServerStatus('running')
    })

    await expect(
      startLocalApiServerAndSettle(start, { ensureModel: false })
    ).resolves.toBe(true)

    expect(start).toHaveBeenCalledWith({ ensureModel: false })
    expect(useAppState.getState().serverStatus).toBe('running')
  })

  it('calls start bare when there are no options, so a model gets loaded', async () => {
    const start = vi.fn(async () => {
      useAppState.getState().setServerStatus('running')
    })

    await expect(startLocalApiServerAndSettle(start)).resolves.toBe(true)

    expect(start).toHaveBeenCalledWith()
  })

  it('clears the `pending` a failed model load leaves behind', async () => {
    // `useLocalApiServerControl.start` sets `pending`, fails to load a model,
    // reports it, and returns without touching the status again.
    const start = vi.fn(async () => {
      useAppState.getState().setServerStatus('pending')
    })

    await expect(startLocalApiServerAndSettle(start)).resolves.toBe(false)

    expect(useAppState.getState().serverStatus).toBe('stopped')
  })
})

describe('restartLocalApiServer', () => {
  const server = {
    start: vi.fn(async () => {
      useAppState.getState().setServerStatus('running')
    }),
    stop: vi.fn(async () => {
      useAppState.getState().setServerStatus('stopped')
      // The core takes the tunnel down with the server and says so.
      tunnel().applyStatus(
        { ...OFF, blockReason: 'server_stopped', canStart: false },
        'event'
      )
    }),
  }

  beforeEach(() => {
    vi.clearAllMocks()
    localStorage.clear()
    tunnel().reset()
    useAppState.setState({ serverStatus: 'running' })
    useLocalApiServer.setState({ remoteAccessAutoStart: false })
  })

  it('goes stop → start without loading a model', async () => {
    const { hub } = makeHub()
    tunnel().applyStatus(OFF, 'event')

    await expect(restartLocalApiServer(hub, server)).resolves.toBe(true)

    expect(server.stop.mock.invocationCallOrder[0]).toBeLessThan(
      server.start.mock.invocationCallOrder[0]
    )
    expect(server.start).toHaveBeenCalledWith({ ensureModel: false })
  })

  it('leaves a tunnel that was off alone', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(OFF, 'event')

    await restartLocalApiServer(hub, server)

    expect(app.startRemoteAccess).not.toHaveBeenCalled()
    expect(tunnel().status?.state).toBe('off')
  })

  it('brings back a tunnel the restart dropped, when auto-start will not', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(ONLINE, 'event')

    await restartLocalApiServer(hub, server)

    expect(app.startRemoteAccess).toHaveBeenCalledTimes(1)
    expect(app.startRemoteAccess.mock.invocationCallOrder[0]).toBeGreaterThan(
      server.start.mock.invocationCallOrder[0]
    )
    expect(tunnel().status?.state).toBe('starting')
    expect(eventsNamed('remote_access_start')).toEqual([
      { trigger_source: 'restore', start_result: 'started' },
    ])
  })

  it('leaves that to the auto-start when it is on, so the tunnel starts once', async () => {
    const { app, hub } = makeHub()
    useLocalApiServer.setState({ remoteAccessAutoStart: true })
    tunnel().applyStatus(ONLINE, 'event')

    await restartLocalApiServer(hub, server)

    expect(app.startRemoteAccess).not.toHaveBeenCalled()
    expect(tunnel().status?.state).toBe('off')
  })

  it('does not ask for a tunnel when the server did not come back', async () => {
    const { app, hub } = makeHub()
    tunnel().applyStatus(ONLINE, 'event')
    server.start.mockImplementationOnce(async () => {
      useAppState.getState().setServerStatus('stopped')
    })

    await expect(restartLocalApiServer(hub, server)).resolves.toBe(false)

    expect(app.startRemoteAccess).not.toHaveBeenCalled()
  })
})
