import { useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { readManagedSnapshot } from '@/services/managed-environment/client'
import { startManagedEnvironmentSync } from '@/services/managed-environment/sync'
import { HOST_STEP_RUNNING_EVENT, useRunningHostSteps } from '@/stores/host-step-running-store'

/**
 * Follows the core's managed-runtime state for the whole session (`startManagedEnvironmentSync`).
 * Linux and Windows: the core has no managed environment on macOS. On Windows on ARM the core
 * answers `unsupported` itself, so the architecture is not checked here.
 */
export function useManagedEnvironmentSync(): void {
  const serviceHub = useServiceHub()

  useEffect(() => {
    if (!IS_LINUX && !IS_WINDOWS) return
    let stop: (() => void) | undefined
    let cancelled = false
    void startManagedEnvironmentSync({
      listen: (name, handler) => serviceHub.events().listen(name, handler),
      readSnapshot: readManagedSnapshot,
    })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else stop = unlisten
      })
      .catch((error) => console.warn('Managed environment events unavailable:', error))
    // The privileged step the person approved is running (Rust, after UAC): say so, not "approve".
    let stopRunning: (() => void) | undefined
    void serviceHub
      .events()
      .listen<{ step_id?: unknown }>(HOST_STEP_RUNNING_EVENT, (event) => {
        if (typeof event.payload?.step_id === 'string') {
          useRunningHostSteps.getState().started(event.payload.step_id)
        }
      })
      .then((unlisten) => {
        if (cancelled) unlisten()
        else stopRunning = unlisten
      })
      .catch((error) => console.warn('Host step events unavailable:', error))
    return () => {
      cancelled = true
      stop?.()
      stopRunning?.()
    }
  }, [serviceHub])
}
