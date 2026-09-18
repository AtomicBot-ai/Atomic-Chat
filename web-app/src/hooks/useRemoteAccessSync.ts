import { useEffect, useRef } from 'react'
import { toast } from 'sonner'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  refreshRemoteAccessStatus,
  startRemoteAccess,
  useRemoteAccessStore,
} from '@/hooks/useRemoteAccess'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { normalizeRemoteAccessStatus } from '@/lib/remoteLan'
import { REMOTE_ACCESS_STATUS_EVENT } from '@/types/remoteAccess'

/**
 * Keeps `useRemoteAccessStore` in step with the tunnel Rust owns, and starts
 * the tunnel on its own when the user asked for that.
 *
 * Mounted once at the root rather than by the settings page: the tunnel lives
 * for the whole session, and "Start automatically" has to work with the page
 * closed. At launch the Local API Server is usually still down, so it cannot
 * honestly mean "at launch" — it means every time the server comes up: app
 * start, the tray, the API screen, sending a message.
 *
 * No-op wherever there is no Local API Server (mobile, web).
 */
export function useRemoteAccessSync(): void {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const serverStatus = useAppState((state) => state.serverStatus)
  const enabled = PlatformFeatures[PlatformFeature.LOCAL_API_SERVER]

  // A new `t` identity must not tear the subscription down.
  const translate = useRef(t)
  translate.current = t

  useEffect(() => {
    if (!enabled) return

    let cancelled = false
    let detach: (() => void) | undefined

    // Rust emits on every transition; the URL arrives seconds after Start and
    // nothing else would tell the page.
    serviceHub
      .events()
      .listen<unknown>(REMOTE_ACCESS_STATUS_EVENT, (event) => {
        const status = normalizeRemoteAccessStatus(event.payload)
        if (status) useRemoteAccessStore.getState().applyStatus(status, 'event')
      })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else detach = unlisten
      })
      .catch((error) => {
        console.warn('Remote access events unavailable:', error)
      })

    void refreshRemoteAccessStatus(serviceHub)

    // An event missed while the webview was suspended is caught up here.
    const handleFocus = () => void refreshRemoteAccessStatus(serviceHub)
    window.addEventListener('focus', handleFocus)

    return () => {
      cancelled = true
      detach?.()
      window.removeEventListener('focus', handleFocus)
    }
  }, [enabled, serviceHub])

  const previousServerStatus = useRef(serverStatus)

  useEffect(() => {
    if (!enabled) return
    const previous = previousServerStatus.current
    previousServerStatus.current = serverStatus
    if (previous === serverStatus) return

    void (async () => {
      // Rust drops the tunnel with the server and reports a different
      // `blockReason`/`canStart` once it is back, so every transition is worth
      // a re-read — and the auto-start below must not decide on a stale state.
      await refreshRemoteAccessStatus(serviceHub)

      // Only the server coming up starts a tunnel, and only if it is still up
      // now that the re-read is back.
      if (serverStatus !== 'running') return
      if (useAppState.getState().serverStatus !== 'running') return
      const { remoteAccessAutoStart, apiKey, exposeWithoutKeyAcknowledged } =
        useLocalApiServer.getState()
      if (!remoteAccessAutoStart) return
      // Exposing the API without a key takes a yes from the user, given once
      // on the settings page. Never assume it here.
      if (apiKey.trim() === '' && !exposeWithoutKeyAcknowledged) return

      const tunnel = useRemoteAccessStore.getState().status?.state
      if (tunnel !== 'off' && tunnel !== 'error') return

      const started = await startRemoteAccess(serviceHub, 'auto')
      if (!started) {
        toast.error(
          translate.current('settings:remoteLan.remote.autoStartFailed')
        )
      }
    })()
  }, [enabled, serverStatus, serviceHub])
}
