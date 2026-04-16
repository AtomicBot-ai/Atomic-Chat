import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { localStorageKey } from '@/constants/localStorage'
import type { ServiceHub } from '@/services'

const LOCAL_PROVIDERS = ['llamacpp', 'mlx'] as const

function setLastUsedModel(provider: string, model: string) {
  try {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider, model })
    )
  } catch (error) {
    console.debug('Failed to set last used model in localStorage:', error)
  }
}

/**
 * Unified model switching function.
 *
 * Ensures only one local model is ever running across both llamacpp and mlx,
 * restarts the Local API Server for the new model, and synchronises all
 * global UI state (dropdown selection, thread model, localStorage, etc.).
 */
export async function switchToModel(params: {
  modelId: string
  providerName: string
  serviceHub: ServiceHub
}): Promise<void> {
  const { modelId, providerName, serviceHub } = params

  if (
    !LOCAL_PROVIDERS.includes(providerName as (typeof LOCAL_PROVIDERS)[number])
  ) {
    console.warn(
      `[switchToModel] Provider '${providerName}' is not a local provider, skipping`
    )
    return
  }

  const { setServerStatus } = useAppState.getState()
  const serverState = useLocalApiServer.getState()

  setServerStatus('pending')
  console.log(
    '[switchToModel] Switching to model:',
    modelId,
    'provider:',
    providerName
  )

  try {
    // 1. Stop ALL local models (both llamacpp and mlx)
    await serviceHub.models().stopAllModels()
    console.log('[switchToModel] All local models stopped')

    // 2. Stop the API server (safe to call even if it wasn't running)
    try {
      await window.core?.api?.stopServer()
      console.log('[switchToModel] Server stopped')
    } catch {
      // Server may not have been running — that's fine
    }

    // 3. Resolve provider object so we can start the model
    const allProviders = useModelProvider.getState().providers
    const provider = allProviders.find((p) => p.provider === providerName)
    if (!provider) {
      throw new Error(`Provider '${providerName}' not found`)
    }

    // 4. Start the new model
    await serviceHub.models().startModel(provider, modelId, true)
    console.log('[switchToModel] Model started:', modelId)
    await new Promise((resolve) => setTimeout(resolve, 500))

    // 5. Start the Local API Server
    const actualPort = await window.core?.api?.startServer({
      host: serverState.serverHost,
      port: serverState.serverPort,
      prefix: serverState.apiPrefix,
      apiKey: serverState.apiKey,
      trustedHosts: serverState.trustedHosts,
      isCorsEnabled: serverState.corsEnabled,
      isVerboseEnabled: serverState.verboseLogs,
      proxyTimeout: serverState.proxyTimeout,
    })
    console.log('[switchToModel] Server started on port:', actualPort)

    if (actualPort && actualPort !== serverState.serverPort) {
      serverState.setServerPort(actualPort)
    }
    setServerStatus('running')
    serverState.setEnableOnStartup(true)

    // 6. Synchronise all global state
    useModelProvider.getState().selectModelProvider(providerName, modelId)

    serverState.setDefaultModelLocalApiServer({
      model: modelId,
      provider: providerName,
    })
    serverState.setLastServerModels([
      { model: modelId, provider: providerName },
    ])

    setLastUsedModel(providerName, modelId)

    useThreads.getState().updateCurrentThreadModel({
      id: modelId,
      provider: providerName,
    })

    console.log('[switchToModel] Global state synchronised')
  } catch (error) {
    console.error('[switchToModel] Failed to switch model:', error)
    useAppState.getState().setServerStatus('stopped')
    throw error
  }
}
