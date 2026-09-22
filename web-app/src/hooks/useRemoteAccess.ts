import { useCallback, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { create } from 'zustand'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import type { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { generateLocalApiKey } from '@/lib/localApiKey'
import {
  REMOTE_ACCESS_TONE,
  buildRemoteApiUrl,
  isCoreFailure,
  isRemoteAccessActionAllowed,
  parseRemoteAccessRejection,
  remoteAccessAction,
  remoteAccessMessage,
  toFailureCode,
  type RemoteAccessRejection,
} from '@/lib/remoteLan'
import { queuedCapture } from '@/lib/telemetry-queue'
import type { ServiceHub } from '@/services'
import type {
  RemoteAccessState,
  RemoteAccessStatus,
} from '@/types/remoteAccess'

export type LocalApiServerControl = ReturnType<typeof useLocalApiServerControl>

/** Where a status came from; decides whether it may overwrite what is shown. */
export type RemoteAccessStatusSource = 'event' | 'mutation' | 'fetch'

/** What asked for the tunnel: the button, the auto-start, or a server restart. */
export type RemoteAccessTrigger = 'manual' | 'auto' | 'restore'

type RemoteAccessStore = {
  /** `null` until the first status arrives. */
  status: RemoteAccessStatus | null
  /**
   * The status read was answered with something that is not a status
   * (`malformed_status`): a contract break, reported rather than guessed
   * around. The relay's `{code, message}` rejections — the core down, not
   * answering, or refusing the request — never set this; see
   * `refreshRemoteAccessStatus`.
   */
  unavailable: boolean
  /** A start/stop command is in flight. */
  busy: 'start' | 'stop' | null
  /** What the last start/stop command was refused with. */
  lastError: RemoteAccessRejection | null
  /** Bumped by every event and command result; see `applyStatus`. */
  revision: number
  /** When the tunnel entered `starting`, for the outcome's `wait_ms`. */
  startedAt: number | null
  applyStatus: (
    next: RemoteAccessStatus,
    source: RemoteAccessStatusSource,
    requestedAt?: number
  ) => void
  reset: () => void
}

const INITIAL = {
  status: null,
  unavailable: false,
  busy: null,
  lastError: null,
  revision: 0,
  startedAt: null,
} satisfies Partial<RemoteAccessStore>

/**
 * The tunnel as the app last heard of it. In memory on purpose: the core owns
 * the process, and the URL is new on every start, so nothing here may outlive
 * the session.
 */
export const useRemoteAccessStore = create<RemoteAccessStore>()((set, get) => ({
  ...INITIAL,
  applyStatus: (next, source, requestedAt) => {
    const previous = get()
    // A reply asked for at `requestedAt` describes the tunnel as of then. If
    // an event or another command result landed since, it is already history:
    // a slow focus refresh must not repaint `off` over a fresh `online`.
    if (
      source !== 'event' &&
      requestedAt !== undefined &&
      requestedAt !== previous.revision
    ) {
      return
    }

    const wasStarting = previous.status?.state === 'starting'
    if (wasStarting && (next.state === 'online' || next.state === 'error')) {
      queuedCapture('remote_access_outcome', {
        outcome: next.state,
        wait_ms: Math.max(0, Date.now() - (previous.startedAt ?? Date.now())),
        ...(next.state === 'error'
          ? { failure_code: toFailureCode(next.error) }
          : {}),
      })
    }

    const stateChanged = previous.status?.state !== next.state
    set({
      status: next,
      unavailable: false,
      revision: source === 'fetch' ? previous.revision : previous.revision + 1,
      startedAt:
        next.state !== 'starting'
          ? null
          : wasStarting
            ? previous.startedAt
            : Date.now(),
      // A refusal explains the state it left behind; once the tunnel moves on
      // it would only contradict what the card shows.
      lastError: stateChanged ? null : previous.lastError,
    })
  },
  reset: () => set(INITIAL),
}))

/** The states that claim a tunnel process, up or on its way up or down. */
const LIVE_TUNNEL_STATES: ReadonlySet<RemoteAccessState> = new Set([
  'starting',
  'online',
  'stopping',
])

/**
 * Re-reads the tunnel status. Never throws: a failure is a state of the card.
 *
 * The read crosses into the core, and a rejection shaped like the relay's
 * `{code, message}` is that call failing this time — the core restarting, not
 * answering, not starting, or refusing the request — not the feature missing.
 * It keeps the last status (or none, before the first) while that can still
 * be true, and the next read, snapshot or server transition catches up. Any
 * other rejection — in practice `malformed_status`, a reply that is not a
 * status — marks the card unavailable.
 */
export async function refreshRemoteAccessStatus(hub: ServiceHub): Promise<void> {
  const requestedAt = useRemoteAccessStore.getState().revision
  try {
    const status = await hub.app().getRemoteAccessStatus()
    useRemoteAccessStore.getState().applyStatus(status, 'fetch', requestedAt)
  } catch (error) {
    console.warn('Remote access status unavailable:', error)
    const { status, revision } = useRemoteAccessStore.getState()
    // An event that arrived meanwhile is newer than anything this failure
    // could say, and proves the core is there.
    if (revision !== requestedAt) return
    if (!isCoreFailure(error)) {
      useRemoteAccessStore.setState({ unavailable: true })
      return
    }
    // The core drops the tunnel with the server, so once the server is known
    // to be gone a kept live state is a dead URL and a Stop that cannot work.
    // `null` shows Off with nothing offered until a read gets through again.
    if (
      status !== null &&
      LIVE_TUNNEL_STATES.has(status.state) &&
      useAppState.getState().serverStatus !== 'running'
    ) {
      useRemoteAccessStore.setState({ status: null, startedAt: null })
    }
  }
}

/**
 * Asks the core for a tunnel. Resolves `true` once one is on its way —
 * including when it already was, since the button, the auto-start and the
 * restore after a server restart can all land here for the same server start
 * and the tunnel must be started once. The outcome itself arrives on the
 * status event.
 */
export async function startRemoteAccess(
  hub: ServiceHub,
  trigger: RemoteAccessTrigger
): Promise<boolean> {
  const store = useRemoteAccessStore
  const { busy, status, revision } = store.getState()
  if (busy === 'stop') return false
  if (
    busy === 'start' ||
    status?.state === 'starting' ||
    status?.state === 'online'
  ) {
    return true
  }

  store.setState({ busy: 'start', lastError: null })
  try {
    const next = await hub.app().startRemoteAccess()
    store.getState().applyStatus(next, 'mutation', revision)
    queuedCapture('remote_access_start', {
      trigger_source: trigger,
      start_result: 'started',
    })
    return true
  } catch (error) {
    const rejection = parseRemoteAccessRejection(error)
    queuedCapture(
      'remote_access_start',
      rejection.kind === 'blocked'
        ? {
            trigger_source: trigger,
            start_result: 'blocked',
            block_reason: rejection.blockReason,
          }
        : {
            trigger_source: trigger,
            start_result: 'failed',
            failure_code: rejection.code,
          }
    )
    await refreshRemoteAccessStatus(hub)
    store.setState({ lastError: rejection })
    return false
  } finally {
    store.setState({ busy: null })
  }
}

/**
 * Stops the tunnel. The core may need ~10 s when the process has to be
 * killed.
 */
export async function stopRemoteAccess(hub: ServiceHub): Promise<boolean> {
  const store = useRemoteAccessStore
  const { busy, revision } = store.getState()
  if (busy !== null) return false

  store.setState({ busy: 'stop', lastError: null })
  try {
    const next = await hub.app().stopRemoteAccess()
    store.getState().applyStatus(next, 'mutation', revision)
    const stopped = next.state === 'off'
    queuedCapture(
      'remote_access_stop',
      stopped
        ? { stop_result: 'stopped' }
        : { stop_result: 'failed', failure_code: toFailureCode(next.error) }
    )
    return stopped
  } catch (error) {
    const rejection = parseRemoteAccessRejection(error)
    queuedCapture('remote_access_stop', {
      stop_result: 'failed',
      failure_code:
        rejection.kind === 'failed' ? rejection.code : rejection.blockReason,
    })
    await refreshRemoteAccessStatus(hub)
    store.setState({ lastError: rejection })
    return false
  } finally {
    store.setState({ busy: null })
  }
}

/**
 * Starts the Local API Server and resolves whether it is up.
 *
 * `server.start()` reports its own failures and never throws. When it fails
 * before the proxy is even asked — no model to load, a load that timed out —
 * it leaves `serverStatus` on `pending`, and both cards are disabled while the
 * server is busy: one failed click would lock the page. The call is over by
 * the time this looks, so a `pending` still standing is that leftover.
 */
export async function startLocalApiServerAndSettle(
  start: LocalApiServerControl['start'],
  options?: Parameters<LocalApiServerControl['start']>[0]
): Promise<boolean> {
  await (options ? start(options) : start())
  const { serverStatus, setServerStatus } = useAppState.getState()
  if (serverStatus === 'pending') setServerStatus('stopped')
  return useAppState.getState().serverStatus === 'running'
}

/**
 * Restarts the Local API Server so it picks up a new host or key: `start` is a
 * no-op while the proxy is up, so every such change goes stop → start.
 *
 * The core drops the tunnel together with the server. With auto-start on,
 * `useRemoteAccessSync` brings it back when the server returns; otherwise this
 * does, so applying a key does not silently take remote access offline.
 * Resolves whether the server came back.
 */
export async function restartLocalApiServer(
  hub: ServiceHub,
  server: Pick<LocalApiServerControl, 'start' | 'stop'>
): Promise<boolean> {
  const tunnelWasOnline =
    useRemoteAccessStore.getState().status?.state === 'online'

  await server.stop()
  const running = await startLocalApiServerAndSettle(server.start, {
    ensureModel: false,
  })

  if (
    running &&
    tunnelWasOnline &&
    !useLocalApiServer.getState().remoteAccessAutoStart
  ) {
    // The `off` event for the dropped tunnel may still be in the queue; ask,
    // so a stale `online` does not talk `startRemoteAccess` out of starting.
    await refreshRemoteAccessStatus(hub)
    await startRemoteAccess(hub, 'restore')
  }
  return running
}

/** State and actions for the Remote access card. */
export function useRemoteAccess({ server }: { server: LocalApiServerControl }) {
  const { t } = useTranslation()
  const hub = useServiceHub()

  const status = useRemoteAccessStore((state) => state.status)
  const unavailable = useRemoteAccessStore((state) => state.unavailable)
  const commandBusy = useRemoteAccessStore((state) => state.busy)
  const lastError = useRemoteAccessStore((state) => state.lastError)

  const apiKey = useLocalApiServer((state) => state.apiKey)
  const apiPrefix = useLocalApiServer((state) => state.apiPrefix)
  const autoStart = useLocalApiServer((state) => state.remoteAccessAutoStart)

  // The click covers more than the tunnel command: it may first have to start
  // or restart the server, which can take as long as loading a model.
  const [working, setWorking] = useState<'start' | null>(null)
  const [restarting, setRestarting] = useState(false)
  const [confirmOpen, setConfirmOpen] = useState(false)
  // The server reads the key once, when it starts, so whatever was in the
  // store at that moment is what it enforces. `null` while it is not running.
  const [appliedKey, setAppliedKey] = useState<string | null>(null)

  const { start: startServer, stop: stopServer, status: serverStatus } = server
  const serverRunning = serverStatus === 'running'

  // `useRemoteAccessSync` keeps the store current for the whole session; one
  // more read on the way in covers an event lost while the page was closed.
  useEffect(() => {
    void refreshRemoteAccessStatus(hub)
  }, [hub])

  useEffect(() => {
    setAppliedKey(serverRunning ? useLocalApiServer.getState().apiKey : null)
  }, [serverRunning])

  const hasStoredKey = apiKey.trim() !== ''
  // What protects the API right now. While the server runs that is the key it
  // was started with, not the one in the field: a key typed a moment ago
  // guards nothing until the restart.
  const hasApiKey =
    serverRunning && status ? status.serverHasApiKey : hasStoredKey
  const keyNeedsRestart =
    serverRunning &&
    ((status !== null && status.serverHasApiKey !== hasStoredKey) ||
      (appliedKey !== null && appliedKey !== apiKey))

  const runStart = useCallback(
    async (restartToApplyKey: boolean) => {
      setWorking('start')
      try {
        let running = useAppState.getState().serverStatus === 'running'
        if (!running) {
          running = await startLocalApiServerAndSettle(startServer)
        } else if (restartToApplyKey) {
          await stopServer()
          running = await startLocalApiServerAndSettle(startServer, {
            ensureModel: false,
          })
        }
        if (!running) {
          // `startServer` has already told the user why; the tunnel was never
          // asked, so say so here rather than let the funnel lose the click.
          queuedCapture('remote_access_start', {
            trigger_source: 'manual',
            start_result: 'blocked',
            block_reason: 'server_stopped',
          })
          return
        }
        await startRemoteAccess(hub, 'manual')
      } finally {
        setWorking(null)
      }
    },
    [hub, startServer, stopServer]
  )

  const generateKey = useCallback(() => {
    useLocalApiServer.getState().setApiKey(generateLocalApiKey())
    queuedCapture('local_api_key_generate', { generate_source: 'remote_lan' })
    toast.success(t('settings:remoteLan.apiKey.generated'))
  }, [t])

  const start = useCallback(() => {
    const { apiKey: key, exposeWithoutKeyAcknowledged } =
      useLocalApiServer.getState()
    if (key.trim() === '' && !exposeWithoutKeyAcknowledged) {
      setConfirmOpen(true)
      return
    }
    void runStart(false)
  }, [runStart])

  const stop = useCallback(() => {
    void stopRemoteAccess(hub)
  }, [hub])

  const confirmGenerateKey = useCallback(() => {
    setConfirmOpen(false)
    queuedCapture('remote_access_no_key_choice', { choice: 'generate' })
    generateKey()
    void runStart(true)
  }, [generateKey, runStart])

  const confirmWithoutKey = useCallback(() => {
    setConfirmOpen(false)
    queuedCapture('remote_access_no_key_choice', { choice: 'without_key' })
    useLocalApiServer.getState().setExposeWithoutKeyAcknowledged(true)
    void runStart(false)
  }, [runStart])

  const cancelConfirm = useCallback(() => {
    setConfirmOpen(false)
    queuedCapture('remote_access_no_key_choice', { choice: 'cancel' })
  }, [])

  const restartServer = useCallback(async () => {
    setRestarting(true)
    try {
      await restartLocalApiServer(hub, { start: startServer, stop: stopServer })
    } finally {
      setRestarting(false)
    }
  }, [hub, startServer, stopServer])

  const setAutoStart = useCallback((enabled: boolean) => {
    useLocalApiServer.getState().setRemoteAccessAutoStart(enabled)
    queuedCapture('remote_access_auto_start_toggle', { enabled })
  }, [])

  const action = remoteAccessAction(status)
  const busy: 'start' | 'stop' | null =
    working ?? commandBusy ?? (status?.state === 'stopping' ? 'stop' : null)

  const message = useMemo(
    () =>
      remoteAccessMessage({
        unavailable,
        rejection: lastError,
        status,
        hasApiKey,
      }),
    [unavailable, lastError, status, hasApiKey]
  )

  return {
    // Nothing is known to be running until the first status says otherwise.
    stateKey: unavailable
      ? 'settings:remoteLan.state.unavailable'
      : `settings:remoteLan.state.${status?.state ?? 'off'}`,
    tone: unavailable || !status ? 'idle' : REMOTE_ACCESS_TONE[status.state],
    action,
    busy,
    disabled:
      unavailable ||
      busy !== null ||
      restarting ||
      server.isBusy ||
      !isRemoteAccessActionAllowed(status, action),
    onAction: action === 'stop' ? stop : start,
    message,
    /** The base URL clients paste, only while the tunnel is up. */
    apiUrl:
      !unavailable && status?.state === 'online'
        ? buildRemoteApiUrl(status.url, apiPrefix)
        : null,
    apiKey,
    hasApiKey,
    generateKey,
    keyNeedsRestart,
    restarting,
    restartDisabled: restarting || working !== null || server.isBusy,
    restartServer,
    autoStart,
    setAutoStart,
    confirmOpen,
    confirmGenerateKey,
    confirmWithoutKey,
    cancelConfirm,
  } as const
}

export type RemoteAccessView = ReturnType<typeof useRemoteAccess>
