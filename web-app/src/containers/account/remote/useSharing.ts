import { useCallback, useState } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  refreshRemoteAccessStatus,
  restartLocalApiServer,
  startLocalApiServerAndSettle,
  startRemoteAccess,
  useRemoteAccessStore,
  type LocalApiServerControl,
} from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import { generateLocalApiKey } from '@/lib/localApiKey'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { toAccountError } from '@/services/account/errors'
import type { AccountError } from '@/services/account/types'
import { useAccountRemoteStore } from '@/stores/account-remote-store'

/**
 * Turning sharing on and off.
 *
 * On: device keys only count on a server that has its own key, so a server
 * without one first gets a generated key (after the person agreed: local
 * tools need it too). Then the server runs with that key, the tunnel starts
 * (and restarts with the app), and the Rust side registers this computer as
 * a host. Off ends every device's access (each pairs again next time); the
 * tunnel is left as it is, since Remote access may be in use for other
 * things.
 */
export function useSharing(server: LocalApiServerControl) {
  const hub = useServiceHub()
  const setStatus = useAccountRemoteStore((state) => state.setStatus)
  const [working, setWorking] = useState(false)
  const [keyPrompt, setKeyPrompt] = useState(false)
  const [error, setError] = useState<AccountError | 'server' | null>(null)

  const run = useCallback(
    async (generateKey: boolean) => {
      setWorking(true)
      setError(null)
      try {
        if (generateKey) {
          useLocalApiServer.getState().setApiKey(generateLocalApiKey())
        }
        const tunnel = PlatformFeatures[PlatformFeature.REMOTE_ACCESS]
        // Set first: a restart below brings the tunnel back by itself.
        if (tunnel) useLocalApiServer.getState().setRemoteAccessAutoStart(true)

        let running = useAppState.getState().serverStatus === 'running'
        if (!running) {
          running = await startLocalApiServerAndSettle(server.start)
        } else {
          // A server started without a key ignores device keys: restart it
          // with the key it has now.
          await refreshRemoteAccessStatus(hub)
          const servedWithKey =
            useRemoteAccessStore.getState().status?.serverHasApiKey
          if (generateKey || servedWithKey === false) {
            running = await restartLocalApiServer(hub, server)
          }
        }
        if (!running) {
          setError('server')
          return
        }
        if (tunnel) await startRemoteAccess(hub, 'manual')
        setStatus(await hub.account().remoteSetSharing(true))
      } catch (raw) {
        setError(toAccountError(raw))
      } finally {
        setWorking(false)
      }
    },
    [hub, server, setStatus]
  )

  const enable = useCallback(() => {
    if (useLocalApiServer.getState().apiKey.trim() === '') {
      setKeyPrompt(true)
      return
    }
    void run(false)
  }, [run])

  const confirmKey = useCallback(() => {
    setKeyPrompt(false)
    void run(true)
  }, [run])

  const cancelKey = useCallback(() => setKeyPrompt(false), [])

  const disable = useCallback(async () => {
    setWorking(true)
    setError(null)
    try {
      setStatus(await hub.account().remoteSetSharing(false))
    } catch (raw) {
      setError(toAccountError(raw))
    } finally {
      setWorking(false)
    }
  }, [hub, setStatus])

  return { enable, disable, confirmKey, cancelKey, keyPrompt, working, error }
}
