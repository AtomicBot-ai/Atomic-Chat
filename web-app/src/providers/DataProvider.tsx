import {
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import { invoke } from '@tauri-apps/api/core'
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
import { useModelLoad } from '@/hooks/useModelLoad'
import { consumeSilentImport } from '@/utils/backgroundImports'
import {
  isDev,
  LOCAL_LLAMACPP_PROVIDER,
  SERVER_START_WATCHDOG_MS,
  withTimeout,
} from '@/lib/utils'
import { AppEvent, events, ModelEvent } from '@janhq/core'
import { toast } from 'sonner'
import { SystemEvent } from '@/types/events'
import {
  parseAtomicChatDeepLink,
  type AtomicChatDeepLinkTarget,
} from '@/services/deeplink/parse'
import {
  isKeylessRemoteProvider,
  isLocalProvider,
  registerRemoteProvider,
  unregisterRemoteProvider,
} from '@/utils/registerRemoteProvider'
import { hydrateActiveModelsForRunningServer } from '@/utils/activeModelsSync'
import { ensureRemoteProviderReady } from '@/utils/ensureRemoteProviderReady'
import { reconcileLaunchAtStartup } from '@/lib/launchAtStartup'

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
    // Only cloud providers should be registered with the backend proxy. Local
    // engines (`llamacpp`, `llamacpp-upstream`, `mlx`, `foundation-models`)
    // run in-process and must never be treated as remote. Both local llama.cpp
    // provider ids are packaged on every desktop platform.
    // The pre-fix check excluded only `'llamacpp'`, which silently leaked
    // `'llamacpp-upstream'` into the remote-registration path on Windows.
    if (
      provider.active &&
      !isLocalProvider(provider.provider) &&
      (provider.api_key || isKeylessRemoteProvider(provider))
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
      const backendType = localStorage.getItem('llama_cpp_backend_type')

      localStorage.clear()

      if (backendType) {
        localStorage.setItem('llama_cpp_backend_type', backendType)
      }

      console.log(
        'Factory reset detected — localStorage force-cleared on startup (backend preserved)'
      )
    }
  }, [])

  useEffect(() => {
    if (!IS_TAURI || isDev()) return
    ;(async () => {
      if (
        IS_MACOS &&
        localStorage.getItem(localStorageKey.autostartAppleScriptMigrated) !==
          'true'
      ) {
        try {
          const hadLegacyAutostart = await invoke<boolean>(
            'migrate_macos_autostart_launchagent'
          )
          if (hadLegacyAutostart && !(await isAutostartEnabled())) {
            await enableAutostart()
          }
          localStorage.setItem(
            localStorageKey.autostartAppleScriptMigrated,
            'true'
          )
        } catch (error) {
          console.error('Failed to migrate macOS autostart launcher:', error)
        }
      }

      try {
        await reconcileLaunchAtStartup(serviceHub.app())
      } catch (error) {
        console.error('Failed to reconcile launch-at-startup state:', error)
      }
    })()
  }, [serviceHub])

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

        const modelState = useModelProvider.getState()
        const selectedProvider = modelState.getProviderByName(
          modelState.selectedProvider
        )
        if (
          modelState.selectedModel &&
          selectedProvider &&
          !isLocalProvider(selectedProvider.provider)
        ) {
          void ensureRemoteProviderReady(selectedProvider, serviceHub).catch(
            (error) => {
              console.error(
                `[LocalAPI:startup] Failed to prepare remote provider ${selectedProvider.provider}:`,
                error
              )
            }
          )
        }
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
          // Keep built-in branding current without overwriting user settings.
          const migrated = (data as unknown as Assistant[]).map((a) =>
            a.id === 'jan'
              ? {
                  ...a,
                  name: defaultAssistant.name,
                  description: defaultAssistant.description,
                  avatar: defaultAssistant.avatar,
                }
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

      try {
        const fetchedProviders = await serviceHub.providers().getProviders()
        setProviders(fetchedProviders)
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

      // Background bulk-imports (onboarding adds every detected model to the
      // library by design) emit `onModelImported` too. Auto-switching to them
      // would hijack the model the user actually picked. This registry is
      // independent of any screen lifecycle, so it also covers imports that
      // settle AFTER the onboarding screen unmounts (when `onboardingActive` is
      // already false again).
      if (consumeSilentImport(modelId)) {
        console.log(
          '[LocalAPI] onModelImported: silent (background) import, skipping auto-switch for',
          modelId
        )
        return
      }

      // While onboarding is on screen it launches the chosen model itself, so
      // DataProvider stands down entirely to avoid double-launching it.
      if (useModelLoad.getState().onboardingActive) {
        console.log(
          '[LocalAPI] onModelImported: onboarding active, skipping auto-switch for',
          modelId
        )
        return
      }

      // Resolve against the post-merge store, not the raw extension payload.
      // This keeps model/provider selection aligned with migrations and
      // persisted deletions before `switchToModel` runs.
      const storeProviders = useModelProvider.getState().providers
      let provider = storeProviders.find((p) =>
        p?.models?.some((m: { id: string }) => m.id === modelId)
      )
      if (!provider) {
        const altId = modelId.replace(/\//g, '\\')
        provider = storeProviders.find((p) =>
          p?.models?.some((m: { id: string }) => m.id === altId)
        )
      }
      if (!provider) {
        provider = storeProviders.find(
          (p) => p?.provider === LOCAL_LLAMACPP_PROVIDER
        )
        console.warn(
          '[LocalAPI] Could not find provider for model',
          modelId,
          `— falling back to ${LOCAL_LLAMACPP_PROVIDER}`
        )
      }
      const providerName = provider?.provider ?? LOCAL_LLAMACPP_PROVIDER
      console.log('[LocalAPI] Provider for model:', providerName)

      console.log(
        '[LocalAPI] Current server status:',
        useAppState.getState().serverStatus
      )

      // A model switch / server start may already be in flight (e.g. the
      // startup auto-start fired right as the download finished). Previously
      // we bailed out on 'pending', which left the freshly downloaded model
      // with nothing running and forced the user to start it manually from
      // Settings after onboarding. Instead, wait for the in-flight operation
      // to settle, then switch to the just-imported model so it auto-starts.
      if (useAppState.getState().serverStatus === 'pending') {
        console.log('[LocalAPI] Server pending — waiting before auto-start')
        const settled = await new Promise<boolean>((resolve) => {
          const startedAt = Date.now()
          const poll = () => {
            if (useAppState.getState().serverStatus !== 'pending') {
              resolve(true)
            } else if (Date.now() - startedAt > 20000) {
              resolve(false)
            } else {
              setTimeout(poll, 500)
            }
          }
          poll()
        })
        if (!settled) {
          console.log(
            '[LocalAPI] Server still pending after wait — skipping auto-start'
          )
          return
        }
      }

      // switchToModel handles stopAllModels, start the new model, start/restart
      // the Local API Server, and syncs all global state.
      try {
        await switchToModel({
          modelId,
          providerName,
          serviceHub,
          isAutoStart: true,
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

  // Mirror any auto-increase of ctx_len performed by a backend extension
  // (triggered by the Local API Server proxy detecting a context-limit error)
  // into the persisted Zustand provider store so the UI stays in sync with
  // the live backend session.
  //
  // We subscribe on TWO redundant channels to guarantee delivery:
  //   1) `ModelEvent.OnAutoIncreasedCtxLen` on `@janhq/core::events`
  //      (in-process EventEmitter singleton hanging off `window.core.events`).
  //   2) `local_backend://auto_increase_ctx_notify` on the native Tauri
  //      event bus (bypasses any @janhq/core bundling quirks).
  //
  // The handler is idempotent: applying the same `newCtxLen` twice simply
  // writes the same value back, so double-delivery is harmless.
  useEffect(() => {
    const applyNewCtxLen = (
      providerName: string,
      modelId: string,
      newCtxLen: number,
      source: string
    ) => {
      const { providers, updateProvider } = useModelProvider.getState()
      const provider = providers.find((p) => p.provider === providerName)
      if (!provider) {
        console.warn(
          `[LocalAPI] OnAutoIncreasedCtxLen (${source}): provider "${providerName}" not found in store`
        )
        return
      }

      const modelIndex = provider.models.findIndex((m) => m.id === modelId)
      if (modelIndex === -1) {
        console.warn(
          `[LocalAPI] OnAutoIncreasedCtxLen (${source}): model "${modelId}" not found in provider "${providerName}"`
        )
        return
      }

      const model = provider.models[modelIndex]
      const currentValue =
        (model.settings?.ctx_len?.controller_props?.value as number | undefined) ??
        null
      if (currentValue === newCtxLen) {
        console.log(
          `[LocalAPI] OnAutoIncreasedCtxLen (${source}): ctx_len for ${providerName}/${modelId} already = ${newCtxLen}, no-op`
        )
        return
      }

      const updatedModel = {
        ...model,
        settings: {
          ...model.settings,
          ctx_len: {
            ...(model.settings?.ctx_len ?? {}),
            controller_props: {
              ...(model.settings?.ctx_len?.controller_props ?? {}),
              value: newCtxLen,
            },
          },
        },
      }

      const updatedModels = [...provider.models]
      updatedModels[modelIndex] = updatedModel as Model

      updateProvider(provider.provider, { models: updatedModels })
      console.log(
        `[LocalAPI] Mirrored auto-increased ctx_len for ${providerName}/${modelId} → ${newCtxLen} (via ${source})`
      )
    }

    const handleFromEvents = (eventData?: Record<string, unknown>) => {
      const providerName = eventData?.provider as string | undefined
      const modelId = eventData?.modelId as string | undefined
      const newCtxLen = eventData?.newCtxLen as number | undefined
      console.log(
        '[LocalAPI] OnAutoIncreasedCtxLen received (core/events)',
        eventData
      )
      if (!providerName || !modelId || typeof newCtxLen !== 'number') {
        console.warn(
          '[LocalAPI] OnAutoIncreasedCtxLen (core/events): invalid payload',
          eventData
        )
        return
      }
      applyNewCtxLen(providerName, modelId, newCtxLen, 'core/events')
    }

    events.on(ModelEvent.OnAutoIncreasedCtxLen, handleFromEvents)

    // Parallel native Tauri bus listener (extensions emit both channels).
    let unlistenTauri: (() => void) | undefined
    let unlistenAtMax: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const unsub = await listen<{
          provider?: string
          modelId?: string
          newCtxLen?: number
        }>('local_backend://auto_increase_ctx_notify', (event) => {
          const { provider, modelId, newCtxLen } = event.payload ?? {}
          console.log(
            '[LocalAPI] auto_increase_ctx_notify received (tauri)',
            event.payload
          )
          if (!provider || !modelId || typeof newCtxLen !== 'number') {
            console.warn(
              '[LocalAPI] auto_increase_ctx_notify (tauri): invalid payload',
              event.payload
            )
            return
          }
          applyNewCtxLen(provider, modelId, newCtxLen, 'tauri')
        })
        if (cancelled) {
          unsub()
          return
        }
        unlistenTauri = unsub
        console.log(
          '[LocalAPI] Subscribed to Tauri event: local_backend://auto_increase_ctx_notify'
        )

        /// Parallel subscription for the hard-stop signal: when an extension
        /// detects that the next ladder step would exceed (or equal) the
        /// model's training-max context, it emits this event so the UI can
        /// inform the user that auto-expand is done. The toast id is keyed
        /// on `provider/modelId` so consecutive overflows on the same model
        /// don't stack up multiple identical toasts.
        const unsubAtMax = await listen<{
          provider?: string
          modelId?: string
          maxCtxLen?: number
          currentCtxLen?: number
        }>('local_backend://auto_increase_ctx_at_max', (event) => {
          const { provider, modelId } = event.payload ?? {}
          console.log(
            '[LocalAPI] auto_increase_ctx_at_max received (tauri)',
            event.payload
          )
          if (!provider || !modelId) {
            console.warn(
              '[LocalAPI] auto_increase_ctx_at_max (tauri): invalid payload',
              event.payload
            )
            return
          }
          toast.error(
            'Model reached its maximum context, auto-expand stopped',
            { id: `ctx-at-max-${provider}-${modelId}` }
          )
        })
        if (cancelled) {
          unsubAtMax()
        } else {
          unlistenAtMax = unsubAtMax
          console.log(
            '[LocalAPI] Subscribed to Tauri event: local_backend://auto_increase_ctx_at_max'
          )
        }
      } catch (e) {
        console.warn(
          '[LocalAPI] Failed to subscribe to Tauri auto_increase_ctx_notify:',
          e
        )
      }
    })()

    return () => {
      cancelled = true
      events.off(ModelEvent.OnAutoIncreasedCtxLen, handleFromEvents)
      if (unlistenTauri) unlistenTauri()
      if (unlistenAtMax) unlistenAtMax()
    }
  }, [])

  // ATO-244: Listen for unexpected llama-server crashes that happen AFTER
  // model load (i.e. during generation). The Rust post-load watcher emits
  // `local_backend://llamacpp_upstream_session_died` when this occurs.
  // Show an actionable toast so the user knows why generation stopped.
  useEffect(() => {
    if (!IS_TAURI) return

    let unlistenSessionDied: (() => void) | undefined
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return
        const unsub = await listen<{
          model_id?: string
          error_code?: string
          message?: string
        }>('local_backend://llamacpp_upstream_session_died', (event) => {
          const { model_id } = event.payload ?? {}
          console.warn(
            '[LocalAPI] llamacpp_upstream_session_died:',
            event.payload
          )
          // ATO-244: the backend process is gone, but `useAppState.activeModels`
          // (the store every "is this model running?" check in the UI reads
          // from — ChatInput's auto-start effect, the status dot, etc.) still
          // lists it as active until something re-queries the engine. Without
          // this, a "New chat" on the same model/provider never re-checks
          // (its auto-start effect only reruns on model/provider change) and
          // just sends straight into the dead backend, surfacing a raw
          // "Connection refused" instead of silently reloading. Dropping the
          // model here flips `isModelActive` to false, which re-triggers that
          // effect and lets it restart the model on its own.
          if (model_id) {
            const { activeModels, setActiveModels } = useAppState.getState()
            if (activeModels.includes(model_id)) {
              setActiveModels(activeModels.filter((id) => id !== model_id))
            }
          }
          toast.error('Model crashed during generation', {
            id: `session-died-${model_id ?? 'unknown'}`,
            description:
              "The model's backend process exited unexpectedly. This can happen with Vulkan backends on some GPU drivers. Try reloading the model, or switch to a CPU backend in Settings → Providers.",
          })
        })
        if (cancelled) {
          unsub()
          return
        }
        unlistenSessionDied = unsub
      } catch (e) {
        console.warn(
          '[LocalAPI] Failed to subscribe to llamacpp_upstream_session_died:',
          e
        )
      }
    })()

    return () => {
      cancelled = true
      if (unlistenSessionDied) unlistenSessionDied()
    }
  }, [])

  // Auto-start Local API Server on app startup, but only re-attach to an
  // already-running server or raise the proxy for a model that is already
  // running in a local engine. We never proactively load/select a model here:
  // if nothing is running, the server stays down until the user starts a model.
  useEffect(() => {
    const autoStartServer = async () => {
      try {
        const { enableOnStartup } = useLocalApiServer.getState()
        if (!enableOnStartup) {
          console.log(
            '[LocalAPI:startup] Local API server auto-start disabled in settings; skipping auto-start'
          )
          return
        }

        const isRunning = await serviceHub.app().getServerStatus()
        if (isRunning) {
          console.log('[LocalAPI:startup] Server already running')
          setServerStatus('running')
          // `activeModels` is in-memory only; without this the provider UI
          // would render "Start" for the cloud model the proxy is already
          // routing, until the user manually re-selects it. See issue where
          // navigating between tabs appears to "forget" the running model.
          await hydrateActiveModelsForRunningServer(serviceHub.models())
          return
        }

        // Product decision: do NOT proactively load or pick a model on startup.
        // The Local API Server is only raised for a model that is already
        // running in a local engine (llamacpp/mlx). If nothing is running, the
        // server stays down until the user starts a model manually.
        const runningModels = await serviceHub.models().getActiveModels()
        if (!runningModels || runningModels.length === 0) {
          console.log(
            '[LocalAPI:startup] No model currently running; leaving server stopped'
          )
          return
        }

        const serverState = useLocalApiServer.getState()
        setServerStatus('pending')
        console.log(
          '[LocalAPI:startup] Raising server for already-running model(s):',
          runningModels
        )
        try {
          // ATO-270: never let a stuck native invoke leave the UI on
          // "Starting Server" forever.
          const startServerCall = window.core?.api?.startServer({
            host: serverState.serverHost,
            port: serverState.serverPort,
            prefix: serverState.apiPrefix,
            apiKey: serverState.apiKey,
            trustedHosts: serverState.trustedHosts,
            isCorsEnabled: serverState.corsEnabled,
            isVerboseEnabled: serverState.verboseLogs,
            proxyTimeout: serverState.proxyTimeout,
          }) as Promise<number> | undefined
          const actualPort = startServerCall
            ? await withTimeout(
                startServerCall,
                SERVER_START_WATCHDOG_MS,
                'Timed out waiting for the Local API Server to start.'
              )
            : undefined
          if (actualPort && actualPort !== serverState.serverPort) {
            serverState.setServerPort(actualPort)
          }
          await hydrateActiveModelsForRunningServer(serviceHub.models())
          setServerStatus('running')
        } catch (err) {
          console.error('[LocalAPI:startup] Server start failed:', err)
          setServerStatus('stopped')
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
