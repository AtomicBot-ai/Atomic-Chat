import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { SERVER_START_WATCHDOG_MS, withTimeout } from '@/lib/utils'
import type { ServiceHub } from '@/services'
import {
  isKeylessRemoteProvider,
  isLocalProvider,
  registerRemoteProvider,
} from '@/utils/registerRemoteProvider'

let readinessQueue: Promise<void> = Promise.resolve()

async function reconcileRemoteProvider(
  provider: ModelProvider,
  serviceHub: Pick<ServiceHub, 'app'>
): Promise<void> {
  if (isLocalProvider(provider.provider)) return

  if (!provider.base_url?.trim()) {
    throw new Error(
      `Remote provider "${provider.provider}" has no configured base URL.`
    )
  }

  if (!provider.api_key?.trim() && !isKeylessRemoteProvider(provider)) {
    throw new Error(
      `Remote provider "${provider.provider}" has no configured API key.`
    )
  }

  const registered = await registerRemoteProvider(provider)
  if (!registered) {
    throw new Error(
      `Remote provider "${provider.provider}" could not be registered.`
    )
  }

  if (await serviceHub.app().getServerStatus()) {
    useAppState.getState().setServerStatus('running')
    return
  }

  const startServer = window.core?.api?.startServer
  if (!startServer) {
    throw new Error('Local API Server is unavailable in this environment.')
  }

  const {
    serverHost,
    serverPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    corsEnabled,
    verboseLogs,
    proxyTimeout,
    setServerPort,
  } = useLocalApiServer.getState()

  useAppState.getState().setServerStatus('pending')

  try {
    const startServerCall = startServer({
      host: serverHost,
      port: serverPort,
      prefix: apiPrefix,
      apiKey,
      trustedHosts,
      isCorsEnabled: corsEnabled,
      isVerboseEnabled: verboseLogs,
      proxyTimeout,
    }) as Promise<number>
    const actualPort = await withTimeout(
      startServerCall,
      SERVER_START_WATCHDOG_MS,
      'Timed out while starting the Local API Server for a remote provider'
    )

    if (actualPort !== serverPort) {
      setServerPort(actualPort)
    }
    useAppState.getState().setServerStatus('running')
  } catch (error) {
    useAppState.getState().setServerStatus('stopped')
    throw error
  }
}

export function ensureRemoteProviderReady(
  provider: ModelProvider,
  serviceHub: Pick<ServiceHub, 'app'>
): Promise<void> {
  const reconciliation = readinessQueue.then(() =>
    reconcileRemoteProvider(provider, serviceHub)
  )
  readinessQueue = reconciliation.catch(() => undefined)
  return reconciliation
}
