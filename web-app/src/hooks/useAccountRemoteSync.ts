import { useEffect } from 'react'
import { useNavigate } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { useServiceHub } from '@/hooks/useServiceHub'
import { syncAccountRemoteProviders } from '@/lib/account-remote-providers'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import {
  setRemotePageOpener,
  useAccountRemoteStore,
} from '@/stores/account-remote-store'

/**
 * Remote access through the account, for the whole session (mounted once, in
 * the root route): follows its state, so a device asking for access raises a
 * toast on any page, and keeps the "<computer> (remote)" providers in step,
 * once at start and on every change Rust announces.
 */
export function useAccountRemoteSync() {
  const hub = useServiceHub()
  const navigate = useNavigate()

  useEffect(() => {
    setRemotePageOpener(() => void navigate({ to: route.account.remote }))
  }, [navigate])

  useEffect(() => {
    if (!PlatformFeatures[PlatformFeature.ACCOUNTS]) return
    void useAccountRemoteStore.getState().hydrate()

    const account = hub.account()
    let cancelled = false
    let unsubscribe: (() => void) | null = null

    void account
      .onRemoteConnections((connections) => {
        void syncAccountRemoteProviders(connections, hub)
      })
      .then((stop) => {
        if (cancelled) stop()
        else unsubscribe = stop
      })
      .catch((error) =>
        console.warn('Failed to follow remote connections:', error)
      )

    void account
      .remoteConnections()
      .then((connections) => {
        if (!cancelled) return syncAccountRemoteProviders(connections, hub)
      })
      .catch((error) =>
        console.warn('Failed to read remote connections:', error)
      )

    return () => {
      cancelled = true
      unsubscribe?.()
    }
  }, [hub])
}
