import { useCallback, useEffect, useMemo, useState } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  restartLocalApiServer,
  startLocalApiServerAndSettle,
  type LocalApiServerControl,
} from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import {
  LAN_ACCESS_TONE,
  buildLanAccessUrls,
  lanAccessMessage,
  lanAccessState,
} from '@/lib/remoteLan'
import { queuedCapture } from '@/lib/telemetry-queue'

/**
 * State and actions for the LAN access card.
 *
 * There is no second listener: LAN access is the Local API Server bound on
 * `0.0.0.0`, so "on the LAN" is the persisted `serverHost`, the card's state
 * is derived from the server's, and "Start automatically" is the server's own
 * `enableOnStartup` — one server, one flag.
 */
export function useLanAccess({
  server,
  hasApiKey,
}: {
  server: LocalApiServerControl
  /** Whether a key protects the API right now; see `useRemoteAccess`. */
  hasApiKey: boolean
}) {
  const serviceHub = useServiceHub()
  const serverHost = useLocalApiServer((state) => state.serverHost)
  const serverPort = useLocalApiServer((state) => state.serverPort)
  const apiPrefix = useLocalApiServer((state) => state.apiPrefix)
  const autoStart = useLocalApiServer((state) => state.enableOnStartup)
  const setAutoStart = useLocalApiServer((state) => state.setEnableOnStartup)

  // `null` until the first lookup is back, so "no addresses" is never a guess.
  const [addresses, setAddresses] = useState<string[] | null>(null)
  const [busy, setBusy] = useState<'start' | 'stop' | null>(null)

  const { start: startServer, stop: stopServer, status: serverStatus } = server
  const state = lanAccessState(serverStatus, serverHost)

  // Addresses change with the network, not with the app: look again whenever
  // the window comes back and whenever LAN access changes state.
  useEffect(() => {
    let cancelled = false
    const load = async () => {
      let next: string[]
      try {
        next = await serviceHub.app().getLanAddresses()
      } catch (error) {
        console.warn('LAN addresses unavailable:', error)
        next = []
      }
      if (!cancelled) setAddresses(next)
    }

    void load()
    const handleFocus = () => void load()
    window.addEventListener('focus', handleFocus)
    return () => {
      cancelled = true
      window.removeEventListener('focus', handleFocus)
    }
  }, [serviceHub, state])

  const start = useCallback(async () => {
    const wasRunning = useAppState.getState().serverStatus === 'running'
    setBusy('start')
    try {
      useLocalApiServer.getState().setServerHost('0.0.0.0')
      const running = wasRunning
        ? await restartLocalApiServer(serviceHub, {
            start: startServer,
            stop: stopServer,
          })
        : await startLocalApiServerAndSettle(startServer)
      queuedCapture('lan_access_toggle', {
        lan_action: 'start',
        lan_result: running ? 'online' : 'failed',
        server_was_running: wasRunning,
      })
    } finally {
      setBusy(null)
    }
  }, [serviceHub, startServer, stopServer])

  const stop = useCallback(async () => {
    const wasRunning = useAppState.getState().serverStatus === 'running'
    setBusy('stop')
    try {
      useLocalApiServer.getState().setServerHost('127.0.0.1')
      // Stop means "stop exposing", not "stop serving": a server that was up
      // comes back on loopback, and one that was down stays down.
      const running = wasRunning
        ? await restartLocalApiServer(serviceHub, {
            start: startServer,
            stop: stopServer,
          })
        : false
      queuedCapture('lan_access_toggle', {
        lan_action: 'stop',
        lan_result: wasRunning && !running ? 'failed' : 'off',
        server_was_running: wasRunning,
      })
    } finally {
      setBusy(null)
    }
  }, [serviceHub, startServer, stopServer])

  const urls = useMemo(
    () =>
      state === 'online'
        ? buildLanAccessUrls(addresses ?? [], serverPort, apiPrefix)
        : [],
    [state, addresses, serverPort, apiPrefix]
  )

  const message = useMemo(
    () =>
      lanAccessMessage({
        state,
        serverStatus,
        serverHost,
        addresses,
        hasApiKey,
      }),
    [state, serverStatus, serverHost, addresses, hasApiKey]
  )

  const action: 'start' | 'stop' = state === 'off' ? 'start' : 'stop'

  return {
    stateKey: `settings:remoteLan.state.${state}`,
    tone: LAN_ACCESS_TONE[state],
    action,
    busy,
    disabled: busy !== null || server.isBusy,
    onAction: action === 'stop' ? stop : start,
    message,
    /** `http://<ip>:<port><prefix>`, only while LAN access is online. */
    urls,
    /** Starting or stopping restarts a running server; say so beforehand. */
    showRestartNote: serverStatus === 'running',
    // Windows asks about the firewall the first time the server binds on
    // 0.0.0.0, and the app never learns the answer.
    showFirewallHint: IS_WINDOWS,
    autoStart,
    setAutoStart,
  } as const
}

export type LanAccessView = ReturnType<typeof useLanAccess>
