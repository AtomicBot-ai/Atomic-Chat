import {
  enable as enableAutostart,
  isEnabled as isAutostartEnabled,
} from '@tauri-apps/plugin-autostart'
import { invoke } from '@tauri-apps/api/core'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  BACKEND_PRESERVE_KEYS,
  localStorageKey,
} from '@/constants/localStorage'

import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect } from 'react'
import { useMCPServers, DEFAULT_MCP_SETTINGS } from '@/hooks/useMCPServers'
import { useAssistant, defaultAssistant } from '@/hooks/useAssistant'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useThreads } from '@/hooks/useThreads'
import { ensureProjectsLoaded } from '@/hooks/useThreadManagement'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useAppState } from '@/hooks/useAppState'
import { useAppUpdater } from '@/hooks/useAppUpdater'
import { consumeSilentImport } from '@/utils/backgroundImports'
import {
  isDev,
  SERVER_START_WATCHDOG_MS,
  withTimeout,
} from '@/lib/utils'
import {
  AppEvent,
  events,
  ModelEvent,
  type Assistant as CoreAssistant,
} from '@janhq/core'
import { migrateGlobalSamplingToAssistants } from '@/lib/samplingParams'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { toast } from 'sonner'
import { SystemEvent } from '@/types/events'
import {
  parseAtomicChatDeepLink,
  type AtomicChatDeepLinkTarget,
} from '@/services/deeplink/parse'
import {
  isKeylessRemoteProvider,
  isLocalProvider,
  isSubscriptionProvider,
  registerRemoteProvider,
  unregisterRemoteProvider,
} from '@/utils/registerRemoteProvider'
import { hydrateActiveModelsForRunningServer } from '@/utils/activeModelsSync'
import { ensureRemoteProviderReady } from '@/utils/ensureRemoteProviderReady'
import { reconcileLaunchAtStartup } from '@/lib/launchAtStartup'
import { ModelFactory } from '@/lib/model-factory'

export function applyAtomicCoreServerState(payload: { running: boolean; port: number | null }) {
  if (payload.running && typeof payload.port === 'number' && payload.port > 0) {
    useLocalApiServer.getState().setServerPort(payload.port)
    useAppState.getState().setServerStatus('running')
  } else if (!payload.running) {
    useAppState.getState().setServerStatus('stopped')
  }
}

/** Providers whose session lookups `ModelFactory` caches (Foundation Models resolves every time). */
const SESSION_CACHED_PROVIDERS = ['llamacpp', 'llamacpp-upstream', 'mlx'] as const
type SessionCachedProvider = (typeof SESSION_CACHED_PROVIDERS)[number]

const isSessionCachedProvider = (
  provider: string
): provider is SessionCachedProvider =>
  (SESSION_CACHED_PROVIDERS as readonly string[]).includes(provider)

/** `atomic-core://session:died`: a loaded session's process exited without being unloaded. */
export type CoreSessionDiedPayload = {
  provider?: string
  pid?: number
  model_id?: string
  exit_code?: number | null
  signal?: string | null
  message?: string
}

/**
 * ATO-244: a local model's process died after it loaded (typically mid-generation). The core
 * reports this for every local runtime it owns, and the recovery does not depend on which one:
 * forget the cached port, mark the model inactive, and tell the user why generation stopped.
 */
export function handleCoreSessionDied(
  payload: CoreSessionDiedPayload | undefined
): void {
  console.warn('[LocalAPI] atomic-core session:died:', payload)
  const provider = payload?.provider ?? 'llamacpp-upstream'
  const modelId = payload?.model_id
  if (isSessionCachedProvider(provider)) {
    ModelFactory.invalidateLocalSessionCache(provider, modelId)
  }
  // `useAppState.activeModels` (the store every "is this model running?" check in the UI reads
  // from — ChatInput's auto-start effect, the status dot, etc.) still lists the model as active
  // until something re-queries the engine. Without this, a "New chat" on the same model/provider
  // never re-checks (its auto-start effect only reruns on model/provider change) and sends
  // straight into the dead backend, surfacing a raw "Connection refused" instead of silently
  // reloading. Dropping the model flips `isModelActive` to false, which re-triggers that effect
  // and lets it restart the model on its own.
  if (modelId) {
    const { activeModels, setActiveModels } = useAppState.getState()
    if (activeModels.includes(modelId)) {
      setActiveModels(activeModels.filter((id) => id !== modelId))
    }
  }
  const llamaCpp = provider === 'llamacpp' || provider === 'llamacpp-upstream'
  toast.error('Model crashed during generation', {
    id: `session-died-${modelId ?? 'unknown'}`,
    description: llamaCpp
      ? "The model's backend process exited unexpectedly. This can happen with Vulkan backends on some GPU drivers. Try reloading the model, or switch to a CPU backend in Settings → Providers."
      : "The model's backend process exited unexpectedly. Try reloading the model.",
  })
}

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
    // Subscriptions (ChatGPT/Codex) hold no `api_key` on the provider object —
    // the token lives in the Rust backend — so they register on the same
    // footing as keyless self-hosted servers.
    if (
      provider.active &&
      !isLocalProvider(provider.provider) &&
      (provider.api_key ||
        isKeylessRemoteProvider(provider) ||
        isSubscriptionProvider(provider.provider))
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
      const preserved = BACKEND_PRESERVE_KEYS.map(
        (key) => [key, localStorage.getItem(key)] as const
      )

      localStorage.clear()

      for (const [key, value] of preserved) {
        if (value) localStorage.setItem(key, value)
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
          const sampling = migrateGlobalSamplingToAssistants(migrated)
          sampling.changed.forEach((assistant) => {
            serviceHub
              .assistants()
              .createAssistant(assistant as unknown as CoreAssistant)
              .catch((error) => {
                console.warn(
                  'Failed to persist migrated assistant sampling:',
                  error
                )
              })
          })
          setAssistants(sampling.assistants)
          initializeWithLastUsed()
        }
      })
      .catch((error) => {
        console.warn('Failed to load assistants, keeping default:', error)
      })
    let cancelled = false
    let detachOpenUrl = () => {}
    let unsubscribe = () => {}

    serviceHub.deeplink().getCurrent().then(handleDeepLink)
    // `onOpenUrl` hands back a detacher; dropping it left the handler
    // registered for the life of the process.
    serviceHub
      .deeplink()
      .onOpenUrl(handleDeepLink)
      .then((detach) => {
        if (cancelled) detach()
        else detachOpenUrl = detach
      })
      .catch((error) => {
        console.warn('Failed to subscribe to deep links:', error)
      })

    // Listen for deep link events
    serviceHub
      .events()
      .listen(SystemEvent.DEEP_LINK, (event) => {
        const deep_link = event.payload as string
        handleDeepLink([deep_link])
      })
      .then((unsub) => {
        if (cancelled) unsub()
        else unsubscribe = unsub
      })
    return () => {
      cancelled = true
      detachOpenUrl()
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

  // Single owner of the initial projects read. Sidebar consumers used to each
  // issue their own `getProjects()` on mount.
  useEffect(() => {
    void ensureProjectsLoaded()
  }, [])

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

      // Deleting a model tombstones its id so a stale engine listing cannot
      // resurrect the row. Importing it again is the user undoing that, so
      // lift the tombstone before the refresh below — otherwise `setProviders`
      // filters the freshly downloaded model straight back out.
      const importedId = eventData?.modelId as string | undefined
      if (importedId) {
        useModelProvider.getState().clearDeletedModel(importedId)
      }

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

      const modelId = importedId
      if (!modelId) {
        console.warn(
          '[LocalAPI] onModelImported: no modelId in event data, skipping'
        )
        return
      }

      // Clear the background-import marker if this was one. Import completion
      // is deliberately library-only for every source: downloading a model
      // must never unload the model serving an active chat or Agent run.
      if (consumeSilentImport(modelId)) {
        console.log(
          '[LocalAPI] onModelImported: background import added to library:',
          modelId
        )
        return
      }
      console.log(
        '[LocalAPI] Model imported into the library; active model unchanged:',
        modelId
      )
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
        (model.settings?.ctx_len?.controller_props?.value as
          | number
          | undefined) ?? null
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
        const detachNotify = createSafeUnlisten(unsub)
        if (cancelled) {
          void detachNotify()
          return
        }
        unlistenTauri = detachNotify
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
        const detachAtMax = createSafeUnlisten(unsubAtMax)
        if (cancelled) {
          void detachAtMax()
        } else {
          unlistenAtMax = detachAtMax
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
      if (unlistenTauri) void unlistenTauri()
      if (unlistenAtMax) void unlistenAtMax()
    }
  }, [])

  // Session lifecycle events relayed from atomic-chat-core. `session:died` is
  // ATO-244's crash report (see `handleCoreSessionDied`); the others only
  // invalidate the cached port so the next request resolves the session again.
  useEffect(() => {
    if (!IS_TAURI) return

    let unlistenCoreSessionEvents: Array<() => void> = []
    let coreServerWasRunning = false
    let cancelled = false
    ;(async () => {
      try {
        const { listen } = await import('@tauri-apps/api/event')
        if (cancelled) return

        const invalidateCoreSession = (event: {
          payload?: { model_id?: string; provider?: string }
        }) => {
          const provider = event.payload?.provider ?? 'llamacpp-upstream'
          if (isSessionCachedProvider(provider)) {
            ModelFactory.invalidateLocalSessionCache(
              provider,
              event.payload?.model_id
            )
          }
        }
        const coreUnsubs = await Promise.all([
          listen('atomic-core://session:started', invalidateCoreSession),
          listen('atomic-core://session:unloaded', invalidateCoreSession),
          listen<CoreSessionDiedPayload>('atomic-core://session:died', (event) =>
            handleCoreSessionDied(event.payload)
          ),
          listen('atomic-core://detached', () => {
            // Every local session lived in the core that just went away.
            for (const provider of SESSION_CACHED_PROVIDERS) {
              ModelFactory.invalidateLocalSessionCache(provider)
            }
            if (coreServerWasRunning) {
              useAppState.getState().setServerStatus('stopped')
              coreServerWasRunning = false
            }
          }),
          listen<{ running: boolean; owner: string; port: number | null; generation: number | null }>(
            'atomic-core://server-state-changed',
            (event) => {
              coreServerWasRunning = event.payload.owner === 'core' && event.payload.running
              applyAtomicCoreServerState(event.payload)
            }
          ),
        ])
        const safeCoreUnsubs = coreUnsubs.map(createSafeUnlisten)
        if (cancelled) {
          safeCoreUnsubs.forEach((unsubscribe) => void unsubscribe())
          return
        }
        unlistenCoreSessionEvents = safeCoreUnsubs
      } catch (e) {
        console.warn(
          '[LocalAPI] Failed to subscribe to atomic-core session events:',
          e
        )
      }
    })()

    return () => {
      cancelled = true
      unlistenCoreSessionEvents.forEach((unsubscribe) => void unsubscribe())
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
        const isRunning = await serviceHub.app().getServerStatus()
        if (isRunning) {
          console.log('[LocalAPI:startup] Server already running')
          // `startServer` is idempotent for an existing listener and returns
          // the port it actually bound, including a fallback port.
          const current = useLocalApiServer.getState()
          const actualPort = await window.core?.api?.startServer({
            host: current.serverHost,
            port: current.serverPort,
            prefix: current.apiPrefix,
            apiKey: current.apiKey,
            trustedHosts: current.trustedHosts,
            isCorsEnabled: current.corsEnabled,
            isVerboseEnabled: current.verboseLogs,
            proxyTimeout: current.proxyTimeout,
          })
          if (actualPort && actualPort !== current.serverPort) current.setServerPort(actualPort)
          setServerStatus('running')
          // `activeModels` is in-memory only; without this the provider UI
          // would render "Start" for the cloud model the proxy is already
          // routing, until the user manually re-selects it. See issue where
          // navigating between tabs appears to "forget" the running model.
          await hydrateActiveModelsForRunningServer(serviceHub.models())
          return
        }

        if (!enableOnStartup) {
          console.log('[LocalAPI:startup] Local API server auto-start disabled in settings')
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
