import { useModelProvider } from '@/hooks/useModelProvider'
import { localStorageKey } from '@/constants/localStorage'
import { EMBEDDING_MODEL_ID } from '@/constants/models'

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
import { switchToModel } from '@/utils/switchModel'
import { isDev } from '@/lib/utils'
import { AppEvent, events } from '@janhq/core'
import { SystemEvent } from '@/types/events'
import {
  parseAtomicChatDeepLink,
  type AtomicChatDeepLinkTarget,
} from '@/services/deeplink/parse'
import {
  registerRemoteProvider,
  unregisterRemoteProvider,
} from '@/utils/registerRemoteProvider'

const safeRegisterRemoteProvider = async (provider: ModelProvider) => {
  try {
    await registerRemoteProvider(provider)
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
    if (
      provider.active &&
      provider.provider !== 'llamacpp' &&
      provider.api_key
    ) {
      safeRegisterRemoteProvider(provider)
      currentActive.add(provider.provider)
    }
  })

  // Unregister providers that were previously registered but are now inactive/removed
  for (const name of registeredProviderNames) {
    if (!currentActive.has(name)) {
      unregisterRemoteProvider(name)
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
    if (localStorage.getItem(localStorageKey.factoryResetPending) === 'true') {
      localStorage.clear()
      console.log(
        'Factory reset detected — localStorage force-cleared on startup'
      )
    }
  }, [])

  useEffect(() => {
    console.log('Initializing DataProvider...')
    serviceHub
      .providers()
      .getProviders()
      .then((providers) => {
        setProviders(providers)
        // Register active remote providers with the backend
        providers.forEach((provider) => {
          if (provider.active) {
            safeRegisterRemoteProvider(provider)
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
        console.error(
          '[LocalAPI] Failed to refresh providers after model import:',
          err
        )
        return
      }

      const modelId = eventData?.modelId as string | undefined
      if (!modelId) {
        console.warn(
          '[LocalAPI] onModelImported: no modelId in event data, skipping'
        )
        return
      }

      if (modelId === EMBEDDING_MODEL_ID) {
        console.log(
          '[LocalAPI] onModelImported: embedding model imported, skipping server switch'
        )
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
        provider =
          newProviders.find((p) => p?.provider === 'llamacpp') ?? undefined
        console.warn(
          '[LocalAPI] Could not find provider for model',
          modelId,
          '— falling back to llamacpp'
        )
      }
      const providerName = provider?.provider ?? 'llamacpp'
      console.log('[LocalAPI] Provider for model:', providerName)

      const currentStatus = useAppState.getState().serverStatus
      console.log('[LocalAPI] Current server status:', currentStatus)

      if (currentStatus === 'pending') {
        console.log('[LocalAPI] Server status is pending — skipping auto-start')
        return
      }

      // switchToModel handles stopAllModels, start the new model, start/restart
      // the Local API Server, and syncs all global state.
      try {
        await switchToModel({
          modelId,
          providerName,
          serviceHub,
        })
        console.log('[LocalAPI] Model imported and switched to:', modelId)
      } catch (error) {
        console.error('[LocalAPI] Failed to switch to imported model:', error)
      }
    }

    events.on(AppEvent.onModelImported, handleModelImported)
    console.log('[LocalAPI] Registered onModelImported handler')
    return () => {
      events.off(AppEvent.onModelImported, handleModelImported)
      console.log('[LocalAPI] Unregistered onModelImported handler')
    }
  }, [serviceHub, setProviders, setServerStatus])

  // Auto-start Local API Server on app startup. Works for both local engines
  // (llamacpp/mlx) and cloud providers: when the last-used model is cloud we
  // just raise the proxy and register the provider config so it can route
  // inference requests by model name.
  useEffect(() => {
    const autoStartServer = async () => {
      try {
        const isRunning = await serviceHub.app().getServerStatus()
        if (isRunning) {
          console.log('[LocalAPI:startup] Server already running')
          setServerStatus('running')
          return
        }

        // Reuse the merged store state so persisted model settings like ctx_len
        // are applied before the startup path launches local models.
        const fetchedProviders = await serviceHub.providers().getProviders()
        setProviders(fetchedProviders)
        const allProviders = useModelProvider.getState().providers
        const localModels = allProviders
          .filter((p) => p.provider === 'llamacpp' || p.provider === 'mlx')
          .flatMap((p) => p.models)
          .filter((m) => m.id !== EMBEDDING_MODEL_ID)

        const serverState = useLocalApiServer.getState()

        type CandidateModel = { model: string; provider: string }

        const isLocalProviderName = (name: string) =>
          name === 'llamacpp' || name === 'mlx'

        const readLastUsedFromStorage = (): CandidateModel | null => {
          try {
            const stored = localStorage.getItem(localStorageKey.lastUsedModel)
            if (!stored) return null
            const parsed = JSON.parse(stored) as CandidateModel
            if (!parsed?.model || !parsed?.provider) return null
            return parsed
          } catch {
            return null
          }
        }

        const validateCandidate = (
          candidate: CandidateModel | null | undefined
        ): CandidateModel | null => {
          if (!candidate) return null
          const p = allProviders.find((pr) => pr.provider === candidate.provider)
          if (!p) return null
          if (!p.models.some((m) => m.id === candidate.model)) return null
          return candidate
        }

        // Priority: explicit UI selection > last-used-model (localStorage) >
        // saved default > last running server model > first available local.
        const modelToStart: CandidateModel | null = (() => {
          const { selectedProvider, selectedModel } = useModelProvider.getState()
          if (selectedModel && selectedProvider) {
            const candidate = validateCandidate({
              model: selectedModel.id,
              provider: selectedProvider,
            })
            if (candidate) return candidate
          }

          const lastUsed = validateCandidate(readLastUsedFromStorage())
          if (lastUsed) return lastUsed

          const savedDefault = validateCandidate(
            serverState.defaultModelLocalApiServer
          )
          if (savedDefault) return savedDefault

          if (serverState.lastServerModels.length > 0) {
            const lastServer = validateCandidate(serverState.lastServerModels[0])
            if (lastServer) return lastServer
          }

          if (localModels.length > 0) {
            const firstLocal = localModels[0]
            const providerName =
              allProviders.find((p) =>
                p.models.some((m) => m.id === firstLocal.id)
              )?.provider ?? 'llamacpp'
            return { model: firstLocal.id, provider: providerName }
          }

          return null
        })()

        if (!modelToStart) {
          console.log(
            '[LocalAPI:startup] No usable model found, skipping auto-start'
          )
          return
        }

        const candidateProvider = allProviders.find(
          (p) => p.provider === modelToStart.provider
        )
        const isCloud =
          candidateProvider !== undefined &&
          !isLocalProviderName(candidateProvider.provider)

        // Cloud provider without an API key cannot be registered with the
        // proxy, so we just bring the server up bare and leave the UI to
        // show "no active model". The user must add an API key in Settings.
        if (isCloud && !candidateProvider?.api_key) {
          console.log(
            '[LocalAPI:startup] Cloud provider selected without API key, raising bare server:',
            modelToStart.provider
          )
          setServerStatus('pending')
          try {
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
          } catch (err) {
            console.error('[LocalAPI:startup] Bare server start failed:', err)
            setServerStatus('stopped')
          }
          return
        }

        setServerStatus('pending')
        console.log(
          '[LocalAPI:startup] Auto-starting, target model:',
          modelToStart
        )

        // switchToModel handles stopAllModels, startModel/registerProvider,
        // startServer, and syncs global state (selectModelProvider,
        // last-used-model, thread model, etc.) for both local and cloud.
        await switchToModel({
          modelId: modelToStart.model,
          providerName: modelToStart.provider,
          serviceHub,
        })
      } catch (error) {
        console.error('[LocalAPI:startup] Failed to auto-start server:', error)
        setServerStatus('stopped')
      }
    }

    autoStartServer()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [serviceHub])

  const handleDeepLink = (urls: string[] | null) => {
    if (!urls?.length) return
    console.log('Received deeplink:', urls)
    const target = urls
      .map(parseAtomicChatDeepLink)
      .find((value): value is AtomicChatDeepLinkTarget => value !== null)
    if (!target) {
      return
    }

    navigate({
      to: route.hub.model,
      params: {
        modelId: target.modelId,
      },
      search: {
        repo: target.repo,
      },
    })
  }

  return null
}
