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
  const { setProviders, getProviderByName } =
    useModelProvider()

  const { setServers, setSettings } = useMCPServers()
  const { setAssistants, initializeWithLastUsed } = useAssistant()
  const { setThreads } = useThreads()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const { checkForUpdate } = useAppUpdater()

  // Local API Server hooks
  const {
    enableOnStartup,
    serverHost,
    serverPort,
    setServerPort,
    apiPrefix,
    apiKey,
    trustedHosts,
    corsEnabled,
    verboseLogs,
    proxyTimeout,
    lastServerModels,
    setLastServerModels,
    defaultModelLocalApiServer,
  } = useLocalApiServer()
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
      const newProviders = await serviceHub.providers().getProviders()
      setProviders(newProviders)
      syncRemoteProviders()

      const modelId = eventData?.modelId as string | undefined
      if (!modelId) return

      const currentStatus = useAppState.getState().serverStatus
      if (currentStatus !== 'stopped') return

      setServerStatus('pending')

      try {
        const allProviders = useModelProvider.getState().providers
        const provider = allProviders.find((p) =>
          p?.models?.some((m: { id: string }) => m.id === modelId)
        )

        if (provider) {
          await serviceHub.models().startModel(provider, modelId, true)
          await new Promise((resolve) => setTimeout(resolve, 500))
        }

        const serverState = useLocalApiServer.getState()

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

        if (actualPort && actualPort !== serverState.serverPort) {
          serverState.setServerPort(actualPort)
        }
        setServerStatus('running')

        const providerName = provider?.provider ?? 'llamacpp'
        serverState.setLastServerModels([
          { model: modelId, provider: providerName },
        ])

        console.log('Auto-started Local API Server with model:', modelId)
      } catch (error) {
        console.error('Failed to auto-start API server after model import:', error)
        setServerStatus('stopped')
      }
    }

    events.on(AppEvent.onModelImported, handleModelImported)
    return () => {
      events.off(AppEvent.onModelImported, handleModelImported)
    }
  }, [serviceHub, setProviders, setServerStatus])

  // Auto-start Local API Server on app startup if enabled
  useEffect(() => {
    if (enableOnStartup) {
      // Check if server is already running
      serviceHub
        .app()
        .getServerStatus()
        .then(async (isRunning) => {
          if (isRunning) {
            console.log('Local API Server is already running')
            setServerStatus('running')
            return
          }

          setServerStatus('pending')

          // Start model(s): prefer user-configured default, fall back to last session's models
          const modelsToStart = (() => {
            if (defaultModelLocalApiServer) {
              return [defaultModelLocalApiServer]
            }
            return lastServerModels
          })()

          if (modelsToStart.length > 0) {
            await Promise.allSettled(
              modelsToStart.map(async ({ model, provider: providerName }) => {
                const provider = getProviderByName(providerName)
                if (!provider) return
                try {
                  await serviceHub.models().startModel(provider, model, true)
                  console.log(`Auto-started server model: ${model}`)
                } catch (err) {
                  console.warn(`Failed to auto-start server model ${model}:`, err)
                }
              })
            )
          }

          return window.core?.api
            ?.startServer({
              host: serverHost,
              port: serverPort,
              prefix: apiPrefix,
              apiKey,
              trustedHosts,
              isCorsEnabled: corsEnabled,
              isVerboseEnabled: verboseLogs,
              proxyTimeout: proxyTimeout,
            })
            .then(async (actualPort: number) => {
              // Store the actual port that was assigned (important for mobile with port 0)
              if (actualPort && actualPort !== serverPort) {
                setServerPort(actualPort)
              }
              setServerStatus('running')
              // Persist whichever models are actually running so next startup can restore them
              const activeModels = await serviceHub.models().getActiveModels().catch(() => [] as string[])
              if (activeModels.length > 0) {
                const allProviders = useModelProvider.getState().providers
                const serverModels = activeModels.flatMap((id) => {
                  const p = allProviders.find((p) => p?.models?.some((m: { id: string }) => m.id === id))
                  return p ? [{ model: id, provider: p.provider }] : []
                })
                if (serverModels.length > 0) setLastServerModels(serverModels)
              }
            })
        })
        .catch((error: unknown) => {
          console.error('Failed to start Local API Server on startup:', error)
          setServerStatus('stopped')
        })
    }
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
