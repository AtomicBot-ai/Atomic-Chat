import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { MODEL_LOAD_WATCHDOG_MS, withTimeout } from '@/lib/utils'
import {
  hydrateActiveModelsForRunningServer,
  syncActiveModelsFromEngines,
} from '@/utils/activeModelsSync'
import { ensureModelForServer } from '@/utils/ensureModelForServer'
import {
  setLocalApiServerRunning,
  stopLocalApiServer,
} from '@/utils/localApiServerControl'

type StartOptions = {
  /** Load a model first when none is running. Defaults to `true`. */
  ensureModel?: boolean
}

/**
 * Start/stop control for the Local API Server, with the model-loading step,
 * the toast taxonomy and the "starting…" states the UI needs.
 *
 * Extracted from `LocalApiServerPanel` so the API screen and the Integrations
 * status row share one implementation instead of a third copy.
 */
export function useLocalApiServerControl() {
  const serviceHub = useServiceHub()
  const { serverStatus, setServerStatus } = useAppState()
  const { defaultModelLocalApiServer, setLastServerModels, serverPort } =
    useLocalApiServer()
  const [isModelLoading, setIsModelLoading] = useState(false)

  const refreshStatus = useCallback(async () => {
    try {
      const running = await serviceHub.app().getServerStatus()
      if (running) {
        setServerStatus('running')
        await hydrateActiveModelsForRunningServer(serviceHub.models())
      }
    } catch (error) {
      console.error('Failed to check server status:', error)
    }
  }, [serviceHub, setServerStatus])

  // The server can be started or stopped from outside this window (tray, CLI,
  // another view), so re-check whenever the window regains focus.
  useEffect(() => {
    void refreshStatus()
    const handleFocus = () => void refreshStatus()
    window.addEventListener('focus', handleFocus)
    return () => window.removeEventListener('focus', handleFocus)
  }, [refreshStatus])

  const start = useCallback(
    async ({ ensureModel = true }: StartOptions = {}) => {
      toast.info('Starting server...', {
        description: `Attempting to start server on port ${serverPort}`,
      })
      setServerStatus('pending')

      try {
        if (ensureModel) {
          // ATO-270: the model load has no timeout of its own; without this
          // watchdog a stuck backend leaves the button spinning forever.
          const result = await withTimeout(
            ensureModelForServer({
              modelsService: serviceHub.models(),
              modelOverride: defaultModelLocalApiServer,
              onLoadStart: () => setIsModelLoading(true),
              onLoadEnd: () => setIsModelLoading(false),
            }),
            MODEL_LOAD_WATCHDOG_MS,
            'Timed out waiting for the model to finish loading.'
          )
          if (result.status === 'no_model_available') {
            throw new Error('No model available to load')
          }

          const activeModels = await serviceHub.models().getActiveModels()
          if (activeModels && activeModels.length > 0) {
            const allProviders = useModelProvider.getState().providers
            const serverModels = activeModels.flatMap((id: string) => {
              const provider = allProviders.find((p) =>
                p?.models?.some((m: { id: string }) => m.id === id)
              )
              return provider ? [{ model: id, provider: provider.provider }] : []
            })
            if (serverModels.length > 0) setLastServerModels(serverModels)
          }
          syncActiveModelsFromEngines(activeModels || [])
        }

        await setLocalApiServerRunning(true)
      } catch (error: unknown) {
        console.error('Error starting server or model:', error)
        setIsModelLoading(false)
        toast.dismiss()
        reportStartFailure(error, serverPort)
      }
    },
    [
      defaultModelLocalApiServer,
      serverPort,
      serviceHub,
      setLastServerModels,
      setServerStatus,
    ]
  )

  const stop = useCallback(async () => {
    try {
      await setLocalApiServerRunning(false)
    } catch (error) {
      console.error('Error stopping server:', error)
    }
  }, [])

  const isRunning = serverStatus !== 'stopped'

  const toggle = useCallback(async () => {
    if (serverStatus === 'stopped') await start()
    else await stop()
  }, [serverStatus, start, stop])

  return {
    status: serverStatus,
    isRunning,
    isModelLoading,
    isBusy: serverStatus === 'pending' || isModelLoading,
    start,
    stop,
    toggle,
    refreshStatus,
  }
}

/** The error taxonomy the settings panel had; kept verbatim. */
function reportStartFailure(error: unknown, serverPort: number) {
  const message =
    error && typeof error === 'object' && 'message' in error
      ? String((error as { message: unknown }).message)
      : String(error)

  if (message.includes('Address already in use')) {
    toast.error('Port has been occupied', {
      description: `Port ${serverPort} is already in use. Please try a different port.`,
    })
  } else if (message.includes('Invalid or inaccessible model path')) {
    toast.error('Invalid or inaccessible model path', { description: message })
  } else if (message.includes('model')) {
    toast.error('Failed to start model', { description: message })
  } else {
    toast.error('Failed to start server', { description: message })
  }
}

export { stopLocalApiServer }
