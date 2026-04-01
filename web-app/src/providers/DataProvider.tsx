import { useModelProvider } from '@/hooks/useModelProvider'

import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect } from 'react'
import { useMCPServers, DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import { useAssistant, defaultAssistant } from '@/hooks/useAssistant'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAppState } from '@/hooks/useAppState'
import { useAppUpdater } from '@/hooks/useAppUpdater'
import { isDev } from '@/lib/utils'
import { toast } from 'sonner'
import { AppEvent, events } from '@janhq/core'
import { SystemEvent } from '@/types/events'
import { invoke } from '@tauri-apps/api/core'

type ProviderCustomHeader = {
  header: string
  value: string
}

type RegisterProviderRequest = {
  provider: string
  api_key?: string
  base_url?: string
  custom_headers: ProviderCustomHeader[]
  models: string[]
}

async function registerRemoteProvider(provider: ModelProvider) {
  // Skip llamacpp - those are local models
  if (provider.provider === 'llamacpp') return

  // Skip providers without API key (they can't make requests)
  if (!provider.api_key) {
    console.log(`Provider ${provider.provider} has no API key, skipping registration`)
    return
  }

  const request: RegisterProviderRequest = {
    provider: provider.provider,
    api_key: provider.api_key,
    base_url: provider.base_url,
    custom_headers: (provider.custom_header || []).map((h) => ({
      header: h.header,
      value: h.value,
    })),
    models: provider.models.map(e => e.id)
  }

  try {
    await invoke('register_provider_config', { request })
    console.log(`Registered remote provider: ${provider.provider}`)
  } catch (error) {
    console.error(`Failed to register provider ${provider.provider}:`, error)
  }
}

// Track which providers have been registered so we can unregister stale ones
let registeredProviderNames = new Set<string>()

// Effect to sync remote providers when providers change
const syncRemoteProviders = () => {
  const providers = useModelProvider.getState().providers
  const currentActive = new Set<string>()

  providers.forEach((provider) => {
    if (provider.active && provider.provider !== 'llamacpp' && provider.api_key) {
      registerRemoteProvider(provider)
      currentActive.add(provider.provider)
    }
  })

  // Unregister providers that were previously registered but are now inactive/removed
  for (const name of registeredProviderNames) {
    if (!currentActive.has(name)) {
      invoke('unregister_provider_config', { provider: name }).catch(() => {})
    }
  }

  registeredProviderNames = currentActive
}

export function DataProvider() {
  const { setProviders } = useModelProvider()

  const { setServers, setSettings } = useMCPServers()
  const { setAssistants, initializeWithLastUsed } = useAssistant()
  const { setThreads } = useThreads()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const { checkForUpdate } = useAppUpdater()

  const setServerStatus = useAppState((state) => state.setServerStatus)

  useEffect(() => {
    console.log('Initializing DataProvider...')
    serviceHub.providers().getProviders().then((providers) => {
      setProviders(providers)
      // Register active remote providers with the backend
      providers.forEach((provider) => {
        if (provider.active) {
          registerRemoteProvider(provider)
          registeredProviderNames.add(provider.provider)
        }
      })
    })
    serviceHub
      .mcp()
      .getMCPConfig()
      .then((data) => {
        setServers(data.mcpServers ?? {})
        setSettings(data.mcpSettings ?? DEFAULT_MCP_SETTINGS)
      })
    serviceHub
      .assistants()
      .getAssistants()
      .then((data) => {
        if (data && Array.isArray(data) && data.length > 0) {
          //? Миграция: ассистент с id 'jan' всегда подменяем на дефолт Atomic Chat (name/description/avatar)
          const migrated = (data as unknown as Assistant[]).map((a) =>
            a.id === 'jan'
              ? { ...defaultAssistant, id: 'jan', created_at: a.created_at }
              : a
          )
          setAssistants(migrated)
          initializeWithLastUsed()
        }
      })
      .catch((error) => {
        console.warn('Failed to load assistants, keeping default:', error)
      })
    serviceHub.deeplink().getCurrent().then(handleDeepLink)
    serviceHub.deeplink().onOpenUrl(handleDeepLink)

    // Listen for deep link events
    let unsubscribe = () => {}
    serviceHub
      .events()
      .listen(SystemEvent.DEEP_LINK, (event) => {
        const deep_link = event.payload as string
        handleDeepLink([deep_link])
      })
      .then((unsub) => {
        unsubscribe = unsub
      })
    return () => {
      unsubscribe()
    }
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])

  useEffect(() => {
    serviceHub
      .threads()
      .fetchThreads()
      .then((threads) => {
        setThreads(threads)
      })
  }, [serviceHub, setThreads])

  // Sync remote providers with backend when providers change
  const providers = useModelProvider.getState().providers
  useEffect(() => {
    syncRemoteProviders()
  }, [providers])

  useEffect(() => {
    if (isDev()) {
      return
    }
    checkForUpdate()
    const intervalId = setInterval(() => {
      console.log('Periodic update check triggered')
      checkForUpdate()
    }, Number(UPDATE_CHECK_INTERVAL_MS))
    return () => {
      clearInterval(intervalId)
    }
  }, [checkForUpdate])

  useEffect(() => {
    const handleModelImported = async (eventData?: Record<string, unknown>) => {
      console.log('[LocalAPI] onModelImported fired, eventData:', eventData)

      let newProviders: ModelProvider[]
      try {
        newProviders = await serviceHub.providers().getProviders()
        setProviders(newProviders)
        syncRemoteProviders()
      } catch (err) {
        console.error('[LocalAPI] Failed to refresh providers after model import:', err)
        return
      }

      const modelId = eventData?.modelId as string | undefined
      if (!modelId) {
        console.warn('[LocalAPI] onModelImported: no modelId in event data, skipping')
        return
      }

      // Find provider — try exact match first, then with normalized separators
      let provider = newProviders.find((p) =>
        p?.models?.some((m: { id: string }) => m.id === modelId)
      )
      if (!provider) {
        const altId = modelId.replace(/\//g, '\\')
        provider = newProviders.find((p) =>
          p?.models?.some((m: { id: string }) => m.id === altId)
        )
      }
      if (!provider) {
        // Fallback: assume llamacpp provider
        provider = newProviders.find((p) => p?.provider === 'llamacpp') ?? undefined
        console.warn('[LocalAPI] Could not find provider for model', modelId, '— falling back to llamacpp')
      }
      const providerName = provider?.provider ?? 'llamacpp'
      console.log('[LocalAPI] Provider for model:', providerName)

      const currentStatus = useAppState.getState().serverStatus
      console.log('[LocalAPI] Current server status:', currentStatus)

      if (currentStatus === 'running') {
        try {
          if (provider) {
            console.log('[LocalAPI] Loading model into running server:', modelId)
            await serviceHub.models().startModel(provider, modelId, true)
          }
          const serverState = useLocalApiServer.getState()
          serverState.setDefaultModelLocalApiServer({ model: modelId, provider: providerName })
          serverState.setLastServerModels([{ model: modelId, provider: providerName }])
          console.log('[LocalAPI] Model loaded into running server, default updated')
        } catch (error) {
          console.error('[LocalAPI] Failed to load model into running server:', error)
        }
        return
      }

      if (currentStatus !== 'stopped') {
        console.log('[LocalAPI] Server status is', currentStatus, '— skipping auto-start')
        return
      }

      setServerStatus('pending')
      console.log('[LocalAPI] Starting API server with model:', modelId)
      toast.info('Starting Local API Server...', { id: 'local-api-autostart' })

      try {
        if (provider) {
          await serviceHub.models().startModel(provider, modelId, true)
          console.log('[LocalAPI] Model started:', modelId)
          await new Promise((resolve) => setTimeout(resolve, 500))
        }

        const serverState = useLocalApiServer.getState()

        console.log('[LocalAPI] Calling startServer on port', serverState.serverPort)
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
        console.log('[LocalAPI] startServer returned port:', actualPort)

        if (actualPort && actualPort !== serverState.serverPort) {
          serverState.setServerPort(actualPort)
        }
        setServerStatus('running')

        serverState.setDefaultModelLocalApiServer({ model: modelId, provider: providerName })
        serverState.setLastServerModels([{ model: modelId, provider: providerName }])
        serverState.setEnableOnStartup(true)

        toast.success('Local API Server started', {
          id: 'local-api-autostart',
          description: `http://${serverState.serverHost}:${actualPort ?? serverState.serverPort}${serverState.apiPrefix}`,
        })
        console.log('[LocalAPI] Auto-started Local API Server with model:', modelId)
      } catch (error) {
        console.error('[LocalAPI] Failed to auto-start API server:', error)
        setServerStatus('stopped')
        toast.error('Failed to start Local API Server', {
          id: 'local-api-autostart',
          description: error instanceof Error ? error.message : String(error),
        })
      }
    }

    events.on(AppEvent.onModelImported, handleModelImported)
    console.log('[LocalAPI] Registered onModelImported handler')
    return () => {
      events.off(AppEvent.onModelImported, handleModelImported)
      console.log('[LocalAPI] Unregistered onModelImported handler')
    }
  }, [serviceHub, setProviders, setServerStatus])

  // Auto-start Local API Server on app startup when local models exist
  useEffect(() => {
    const autoStartServer = async () => {
      try {
        const isRunning = await serviceHub.app().getServerStatus()
        if (isRunning) {
          console.log('[LocalAPI:startup] Server already running')
          setServerStatus('running')
          return
        }

        // Fetch providers to check for local models
        const allProviders = await serviceHub.providers().getProviders()
        const localModels = allProviders
          .filter((p) => p.provider === 'llamacpp' || p.provider === 'mlx')
          .flatMap((p) => p.models)

        if (localModels.length === 0) {
          console.log('[LocalAPI:startup] No local models found, skipping auto-start')
          return
        }

        setServerStatus('pending')
        console.log('[LocalAPI:startup] Auto-starting server, local models found:', localModels.length)

        const serverState = useLocalApiServer.getState()

        // Pick model to load: saved default > last server models > first available local model
        const modelsToStart = (() => {
          if (serverState.defaultModelLocalApiServer) {
            return [serverState.defaultModelLocalApiServer]
          }
          if (serverState.lastServerModels.length > 0) {
            return serverState.lastServerModels
          }
          const firstLocal = localModels[0]
          const providerName = allProviders.find((p) =>
            p.models.some((m) => m.id === firstLocal.id)
          )?.provider ?? 'llamacpp'
          return [{ model: firstLocal.id, provider: providerName }]
        })()

        console.log('[LocalAPI:startup] Models to start:', modelsToStart)

        await Promise.allSettled(
          modelsToStart.map(async ({ model, provider: providerName }) => {
            const provider = allProviders.find((p) => p.provider === providerName)
            if (!provider) {
              console.warn(`[LocalAPI:startup] Provider '${providerName}' not found for model '${model}'`)
              return
            }
            try {
              await serviceHub.models().startModel(provider, model, true)
              console.log(`[LocalAPI:startup] Model started: ${model}`)
            } catch (err) {
              console.warn(`[LocalAPI:startup] Failed to start model ${model}:`, err)
            }
          })
        )

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
        console.log('[LocalAPI:startup] Server started on port:', actualPort)

        if (actualPort && actualPort !== serverState.serverPort) {
          serverState.setServerPort(actualPort)
        }
        setServerStatus('running')
        serverState.setEnableOnStartup(true)

        // Persist running models for next startup
        if (modelsToStart.length > 0) {
          serverState.setLastServerModels(modelsToStart)
          if (!serverState.defaultModelLocalApiServer) {
            serverState.setDefaultModelLocalApiServer(modelsToStart[0])
          }
        }
      } catch (error) {
        console.error('[LocalAPI:startup] Failed to auto-start server:', error)
        setServerStatus('stopped')
      }
    }

    autoStartServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])

  const handleDeepLink = (urls: string[] | null) => {
    if (!urls) return
    console.log('Received deeplink:', urls)
    const deeplink = urls[0]
    if (deeplink) {
      const url = new URL(deeplink)
      const params = url.pathname.split('/').filter((str) => str.length > 0)

      if (params.length < 3) return undefined
      // const action = params[0]
      // const provider = params[1]
      const resource = params.slice(1).join('/')
      // return { action, provider, resource }
      navigate({
        to: route.hub.model,
        search: {
          repo: resource,
        },
      })
    }
  }

  return null
}
