import { useCallback, useEffect, useState } from 'react'
import { toast } from 'sonner'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useServiceHub } from '@/hooks/useServiceHub'
import { MODEL_LOAD_WATCHDOG_MS, withTimeout } from '@/lib/utils'
import {
  hydrateActiveModelsForRunningServer,
  syncActiveModelsFromEngines,
} from '@/utils/activeModelsSync'
import {
  ensureModelForServer,
  findProviderForModel,
} from '@/utils/ensureModelForServer'
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
      const requestedPort = serverPort
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
            // Both llama.cpp providers list the same models folder, so "the first
            // provider that has this id" named TurboQuant — off on a fresh install,
            // with no backend — for a model the default provider was running. An
            // active provider is preferred, as it is when the model is loaded.
            const serverModels = activeModels.flatMap((id: string) => {
              const provider = findProviderForModel(id)
              return provider ? [{ model: id, provider: provider.provider }] : []
            })
            if (serverModels.length > 0) setLastServerModels(serverModels)
          }
          syncActiveModelsFromEngines(activeModels || [])
        }

        await setLocalApiServerRunning(true)

        // The core falls back to a free port when the configured one is taken, and the store
        // follows it. Until now that happened in silence: the user points Codex, OpenCode or a
        // script at the port they set, gets a refused connection, and has nothing on screen that
        // explains why. Say it, and say it long enough to be read.
        const boundPort = useLocalApiServer.getState().serverPort
        if (boundPort && boundPort !== requestedPort) {
          toast.warning('Server started on a different port', {
            description: `Port ${requestedPort} was already in use, so the server is listening on ${boundPort}. Point anything you configured for ${requestedPort} at the new port.`,
            duration: 30000,
          })
        }
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
