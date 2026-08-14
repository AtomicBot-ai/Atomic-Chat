/* eslint-disable @typescript-eslint/no-explicit-any */
import { Card, CardItem } from '@/containers/Card'
import HeaderPage from '@/containers/HeaderPage'
import SettingsMenu from '@/containers/SettingsMenu'
import { useModelProvider } from '@/hooks/useModelProvider'
import {
  cn,
  getProviderTitle,
  getModelDisplayName,
  LOCAL_LLAMACPP_PROVIDER,
} from '@/lib/utils'
import {
  createFileRoute,
  Link,
  useNavigate,
  useParams,
} from '@tanstack/react-router'
import { useTranslation } from '@/i18n/react-i18next-compat'
import Capabilities from '@/containers/Capabilities'
import {
  ModelSourceBadge,
  MissingModelBadge,
} from '@/components/ModelSourceBadge'
import { DynamicControllerSetting } from '@/containers/dynamicControllerSetting'
import { RenderMarkdown } from '@/containers/RenderMarkdown'
import { DialogEditModel } from '@/containers/dialogs/EditModel'
import { ImportVisionModelDialog } from '@/containers/dialogs/ImportVisionModelDialog'
import { ImportMlxModelDialog } from '@/containers/dialogs/ImportMlxModelDialog'
import { DflashUnsupportedDialog } from '@/containers/dialogs/DflashUnsupportedDialog'
import { MtpUnsupportedDialog } from '@/containers/dialogs/MtpUnsupportedDialog'
import { Eagle3UnsupportedDialog } from '@/containers/dialogs/Eagle3UnsupportedDialog'
import { LlamacppMtpUnsupportedDialog } from '@/containers/dialogs/LlamacppMtpUnsupportedDialog'
import { LlamacppDflashUnsupportedDialog } from '@/containers/dialogs/LlamacppDflashUnsupportedDialog'
import {
  LlamacppDflashDraftDialog,
  type LlamacppDflashDraftOption,
} from '@/containers/dialogs/LlamacppDflashDraftDialog'
import { ModelSetting } from '@/containers/ModelSetting'
import { DialogDeleteModel } from '@/containers/dialogs/DeleteModel'
import { FavoriteModelAction } from '@/containers/FavoriteModelAction'
import { route } from '@/constants/routes'
import DeleteProvider from '@/containers/dialogs/DeleteProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  isKeylessRemoteProvider,
  isLocalProvider,
  isLoopbackUrl,
  unregisterRemoteProvider,
} from '@/utils/registerRemoteProvider'
import { syncActiveModelsFromEngines } from '@/utils/activeModelsSync'
import {
  IconAlertTriangle,
  IconFolderPlus,
  IconLoader,
  IconRefresh,
  IconRocket,
  IconSearch,
  IconUpload,
} from '@tabler/icons-react'
import { useBackendMismatch } from '@/hooks/useBackendMismatch'
import { toast } from 'sonner'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'
import {
  isKnownProvider,
  useProviderRegistryStore,
} from '@/stores/provider-registry-store'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { getModelCapabilities } from '@/lib/models'
import { useModelLoad } from '@/hooks/useModelLoad'
import { switchToModel } from '@/utils/switchModel'
import { useLlamacppDevices } from '@/hooks/useLlamacppDevices'
import {
  useBackendUpdater,
  type UseBackendUpdaterConfig,
} from '@/hooks/useBackendUpdater'
import { basenameNoExt } from '@/lib/utils'
import { useAppState } from '@/hooks/useAppState'
import { useShallow } from 'zustand/shallow'
import { DialogAddModel } from '@/containers/dialogs/AddModel'
import { AppEvent, EngineManager, events } from '@janhq/core'
import debounce from 'lodash.debounce'
import { restartLocalModel } from '@/utils/restartLocalModel'

// as route.threadsDetail
export const Route = createFileRoute('/settings/providers/$providerName')({
  component: ProviderDetail,
  validateSearch: (search: Record<string, unknown>): { step?: string } => {
    // validate and parse the search params into a typed state
    return {
      step: String(search?.step),
    }
  },
})

function ProviderDetail() {
  const { t } = useTranslation()
  const { providerName } = useParams({ from: Route.id })
  const serviceHub = useServiceHub()
  const { setModelLoadError } = useModelLoad()
  const [activeModels, setActiveModels] = useAppState(
    useShallow((state) => [state.activeModels, state.setActiveModels])
  )
  const [loadingModels, setLoadingModels] = useState<string[]>([])
  const [refreshingModels, setRefreshingModels] = useState(false)
  const [isInstallingBackend, setIsInstallingBackend] = useState(false)
  const [isRecheckingBackend, setIsRecheckingBackend] = useState(false)
  const [isCheckingEngineUpdate, setIsCheckingEngineUpdate] = useState(false)
  /// localStorage key holding the pending backend of the provider this page
  /// shows. Each llama provider writes its own key, so reading the upstream
  /// one on the turboquant page would show a foreign backend as pending.
  const pendingBackendKey =
    providerName === 'llamacpp'
      ? 'turboquant_pending_backend'
      : 'llama_cpp_pending_backend'
  /// Mirrors the provider's pending-backend key so the provider settings
  /// page can surface a "restart to activate" pill next to the (still-old)
  /// `version_backend` value once a recommended GPU backend has finished
  /// downloading. Updated reactively via
  /// `AppEvent.onBackendDownloadFinished` so the user gets feedback
  /// without having to refresh.
  const [pendingBackend, setPendingBackend] = useState<string | null>(() => {
    if (typeof window === 'undefined') return null
    const raw = localStorage.getItem(pendingBackendKey)
    return raw ? raw.replace(/\uFEFF/g, '').trim() : null
  })

  useEffect(() => {
    const refresh = () => {
      const raw = localStorage.getItem(pendingBackendKey)
      setPendingBackend(raw ? raw.replace(/\uFEFF/g, '').trim() : null)
    }
    refresh()
    const onFinished = (payload: { status: string; provider?: string }) => {
      if ((payload?.provider ?? LOCAL_LLAMACPP_PROVIDER) !== providerName) return
      if (payload?.status === 'completed') refresh()
    }
    /// Hot-swap path: the extension already cleared its pending key and
    /// updated `version_backend` settings.
    /// Drop the pill immediately and pull fresh provider settings so the
    /// `version_backend` row reflects the new value without a tab refresh.
    ///
    /// We deliberately read `setProviders` from the Zustand store via
    /// `getState()` instead of capturing the destructured binding from
    /// `useModelProvider()` — that destructuring happens later in the
    /// component body, so referencing it here would hit a TDZ
    /// `ReferenceError` on the very first render.
    const onHotswapped = (event: Event) => {
      const detail = (event as CustomEvent<{ provider?: string }>).detail
      if ((detail?.provider ?? LOCAL_LLAMACPP_PROVIDER) !== providerName) return
      setPendingBackend(null)
      void serviceHub
        .providers()
        .getProviders()
        .then((providers) => {
          useModelProvider.getState().setProviders(providers)
        })
        .catch((err) => {
          console.warn('Failed to refresh providers after hot-swap:', err)
        })
    }
    events.on(AppEvent.onBackendDownloadFinished, onFinished)
    window.addEventListener('storage', refresh)
    window.addEventListener('app:backend-hotswapped', onHotswapped)
    return () => {
      events.off(AppEvent.onBackendDownloadFinished, onFinished)
      window.removeEventListener('storage', refresh)
      window.removeEventListener('app:backend-hotswapped', onHotswapped)
    }
  }, [serviceHub, providerName, pendingBackendKey])

  const handleRestartForPendingBackend = useCallback(async () => {
    try {
      await window.core?.api?.relaunch()
    } catch (err) {
      console.error('Failed to relaunch for pending backend:', err)
    }
  }, [])
  const [importingModel, setImportingModel] = useState<string | null>(null)
  const [isTogglingDflash, setIsTogglingDflash] = useState(false)
  /// `isTogglingDflash` covers fast operations (lookup + MLX reload) and
  /// drives the inline spinner next to the Switch. The HF download leg
  /// is much longer and has its own progress UI in the left panel, so
  /// we track it separately: the Switch stays disabled (avoids racy
  /// re-entry) but the redundant spinner is hidden.
  const [isDflashDownloading, setIsDflashDownloading] = useState(false)
  const [dflashUnsupportedModel, setDflashUnsupportedModel] = useState<
    string | null
  >(null)
  /// MTP mirror of the DFlash state. `isTogglingMtp` drives the inline
  /// spinner next to the MTP Switch; `isMtpDownloading` keeps the Switch
  /// disabled while the HF download is in flight (progress is owned by
  /// the global DownloadManagement panel).
  const [isTogglingMtp, setIsTogglingMtp] = useState(false)
  const [isMtpDownloading, setIsMtpDownloading] = useState(false)
  const [mtpUnsupportedModel, setMtpUnsupportedModel] = useState<string | null>(
    null
  )
  /// EAGLE-3 mirror of the MTP state. `isTogglingEagle3` drives the inline
  /// spinner next to the EAGLE-3 Switch; `isEagle3Downloading` keeps the
  /// Switch disabled while the HF download is in flight (progress is owned
  /// by the global DownloadManagement panel).
  const [isTogglingEagle3, setIsTogglingEagle3] = useState(false)
  const [isEagle3Downloading, setIsEagle3Downloading] = useState(false)
  const [eagle3UnsupportedModel, setEagle3UnsupportedModel] = useState<
    string | null
  >(null)
  /// Upstream-llama MTP toggle state. Mirrors the MLX MTP shape but
  /// targets `llamacpp-upstream`'s `mtp` setting key (no separate downloader
  /// — the MTP head ships inside the same GGUF as the target).
  const [isTogglingLlamacppMtp, setIsTogglingLlamacppMtp] = useState(false)
  const [llamacppMtpUnsupportedModel, setLlamacppMtpUnsupportedModel] =
    useState<string | null>(null)
  const [isTogglingLlamacppDflash, setIsTogglingLlamacppDflash] =
    useState(false)
  const [llamacppDflashUnsupportedModel, setLlamacppDflashUnsupportedModel] =
    useState<string | null>(null)
  const [llamacppDflashDraftSelection, setLlamacppDflashDraftSelection] =
    useState<{
      modelId: string
      options: LlamacppDflashDraftOption[]
    } | null>(null)
  /// The turboquant provider (`llamacpp`) ships alongside upstream on
  /// Windows/Linux. Each owns its own backend tree + localStorage keys, so
  /// the updater must be configured per-provider to avoid cross-contamination
  /// (see the 2026-06-23 turboquant-on-Win/Linux ADR). macOS turboquant has a
  /// single backend and never reaches the optimal-backend UI.
  const isTurboquantProvider = providerName === 'llamacpp'
  const backendUpdaterConfig = useMemo<UseBackendUpdaterConfig>(
    () =>
      isTurboquantProvider
        ? {
            extensionName: '@janhq/llamacpp-extension',
            providerId: 'llamacpp',
            recommendationKey: 'turboquant_better_backend_recommendation',
            postUpgradeRecheckEnabled: false,
          }
        : {},
    [isTurboquantProvider]
  )
  const {
    installBackend,
    recheckOptimalBackend,
    checkForEngineUpdate,
    refreshBackendCatalog,
    downloadRecommendedBackend,
    recommendationPhase,
    selectManualBackend,
  } = useBackendUpdater(backendUpdaterConfig)
  /// The last load may have run on a backend other than the one selected here
  /// (a silent in-memory swap, or a GPU build that fell back to the CPU). Show
  /// that truth next to the dropdown instead of letting the stale selection
  /// speak for the running process.
  const { pending: backendMismatch } = useBackendMismatch()
  const runningBackendNotice = useMemo(() => {
    if (!backendMismatch || backendMismatch.provider !== providerName) {
      return null
    }
    const { mismatch } = backendMismatch
    if (mismatch.kind === 'silent-fallback') {
      return t('settings:backendMismatch.actuallyRunning', {
        backend: mismatch.effective,
      })
    }
    if (mismatch.kind === 'runtime-cpu') {
      return mismatch.total
        ? t('settings:backendMismatch.actuallyRunningCpuLayers', {
            offloaded: mismatch.offloaded ?? 0,
            total: mismatch.total,
          })
        : t('settings:backendMismatch.actuallyRunningDevice', {
            device: mismatch.primaryDevice,
          })
    }
    return null
  }, [backendMismatch, providerName, t])
  const navigate = useNavigate()
  const { getProviderByName, setProviders, updateProvider } = useModelProvider()
  const provider = getProviderByName(providerName)
  const providerSettingsWriteRef = useRef<Promise<void>>(Promise.resolve())
  const debouncedRestartLlamacppModel = useMemo(
    () =>
      debounce(async (targetProvider: string) => {
        try {
          await providerSettingsWriteRef.current
          const loadedModels = await serviceHub
            .models()
            .getActiveModels(targetProvider)
          const activeModel = loadedModels[0]
          if (activeModel) {
            await restartLocalModel(serviceHub, targetProvider, activeModel)
          }
        } catch (error) {
          console.error(
            'Failed to apply provider settings to the running model:',
            error
          )
        }
      }, 500),
    [serviceHub]
  )

  useEffect(
    () => () => {
      debouncedRestartLlamacppModel.cancel()
    },
    [debouncedRestartLlamacppModel]
  )

  const hasDownloadedModels =
    (provider?.models.filter((m) => m.id !== EMBEDDING_MODEL_ID).length ?? 0) >
    0

  // Check if llamacpp/mlx provider needs backend configuration
  const needsBackendConfig =
    (provider?.provider === 'llamacpp' ||
      provider?.provider === 'llamacpp-upstream' ||
      provider?.provider === 'mlx') &&
    provider.settings?.some(
      (setting) =>
        setting.key === 'version_backend' &&
        (setting.controller_props.value === 'none' ||
          setting.controller_props.value === '' ||
          !setting.controller_props.value)
    )

  const handleModelImportSuccess = async (importedModelName?: string) => {
    if (importedModelName) {
      setImportingModel(importedModelName)
    }

    try {
      // Refresh the provider to update the models list
      await serviceHub.providers().getProviders().then(setProviders)

      // If a model was imported and it might have vision capabilities, check and update
      if (importedModelName && providerName === 'llamacpp') {
        try {
          const mmprojExists = await serviceHub
            .models()
            .checkMmprojExists(importedModelName)
          if (mmprojExists) {
            // Get the updated provider after refresh
            const { getProviderByName, updateProvider: updateProviderState } =
              useModelProvider.getState()
            const llamacppProvider = getProviderByName('llamacpp')

            if (llamacppProvider) {
              const modelIndex = llamacppProvider.models.findIndex(
                (m: Model) => m.id === importedModelName
              )
              if (modelIndex !== -1) {
                const model = llamacppProvider.models[modelIndex]
                const capabilities = model.capabilities || []

                // Add 'vision' capability if not already present AND if user hasn't manually configured capabilities
                // Check if model has a custom capabilities config flag

                const hasUserConfiguredCapabilities =
                  (model as any)._userConfiguredCapabilities === true

                if (
                  !capabilities.includes('vision') &&
                  !hasUserConfiguredCapabilities
                ) {
                  const updatedModels = [...llamacppProvider.models]
                  updatedModels[modelIndex] = {
                    ...model,
                    capabilities: [...capabilities, 'vision'],
                    // Mark this as auto-detected, not user-configured
                    _autoDetectedVision: true,
                  } as any

                  updateProviderState('llamacpp', { models: updatedModels })
                  console.log(
                    `Vision capability added to model after provider refresh: ${importedModelName}`
                  )
                }
              }
            }
          }
        } catch (error) {
          console.error('Error checking mmproj existence after import:', error)
        }
      }
    } finally {
      // The importing state will be cleared by the useEffect when model appears in list
    }
  }

  useEffect(() => {
    // Refresh local-engine-backed active models when entering this provider's
    // settings screen. Cloud models live only in frontend state (the Local API
    // Server proxy tracks them via register_provider_config), so we must
    // preserve any cloud entries instead of blindly overwriting.
    if (provider?.provider) {
      serviceHub
        .models()
        .getActiveModels(provider.provider)
        .then((models) => syncActiveModelsFromEngines(models || []))
    }
  }, [serviceHub, provider?.provider])

  // Clear importing state when model appears in the provider's model list
  useEffect(() => {
    if (importingModel && provider?.models) {
      const modelExists = provider.models.some(
        (model) => model.id === importingModel
      )
      if (modelExists) {
        setImportingModel(null)
      }
    }
  }, [importingModel, provider?.models])

  // Fallback: Clear importing state after 10 seconds to prevent infinite loading
  useEffect(() => {
    if (importingModel) {
      const timeoutId = setTimeout(() => {
        setImportingModel(null)
      }, 10000) // 10 seconds fallback

      return () => clearTimeout(timeoutId)
    }
  }, [importingModel])

  /// Track the currently-running MLX model id (if this provider is `mlx`).
  /// Whenever it changes we reset `dflash_enabled`, `mtp_enabled` and
  /// `eagle3_enabled` to `false` because:
  ///   1. The new session was just started fresh without `--draft-model`,
  ///      so the UI flags would otherwise lie about the server state.
  ///   2. The previous draft repo is almost certainly wrong for the new
  ///      target — drafts are paired 1:1 with a base model and the new
  ///      model may not even be on either supported list.
  /// The user can opt back in explicitly after the new session is up.
  const activeMlxModelId = useMemo(() => {
    if (provider?.provider !== 'mlx') return undefined
    const mlxIds = new Set(provider.models.map((m) => m.id))
    return activeModels.find((id) => mlxIds.has(id))
  }, [activeModels, provider])

  /// Set by `handleStartWithDflash` to the model id it just started *with* a
  /// DFlash draft, so the reset effect below skips its one-shot flag wipe for
  /// that session (the session genuinely started with `--draft-model`, unlike
  /// a plain start). Cleared the moment the effect honors it.
  const startedWithDflashRef = useRef<string | null>(null)

  const prevActiveMlxModelRef = useRef<string | undefined>(undefined)
  useEffect(() => {
    if (provider?.provider !== 'mlx' || !provider) {
      prevActiveMlxModelRef.current = undefined
      return
    }

    const prev = prevActiveMlxModelRef.current
    prevActiveMlxModelRef.current = activeMlxModelId

    /// Skip the very first render (when `prev` is still `undefined`):
    /// we don't want to nuke the user's choice just because we mounted.
    if (prev === undefined) return
    if (prev === activeMlxModelId) return

    /// This session was deliberately started with a DFlash draft (via the
    /// "DFlash unavailable" dialog's Start action), so don't wipe the flag.
    if (activeMlxModelId && activeMlxModelId === startedWithDflashRef.current) {
      startedWithDflashRef.current = null
      return
    }

    const dflashSetting = provider.settings.find(
      (s) => s.key === 'dflash_enabled'
    )
    const dflashOn = !!(
      dflashSetting?.controller_props as { value?: boolean } | undefined
    )?.value
    const mtpSetting = provider.settings.find((s) => s.key === 'mtp_enabled')
    const mtpOn = !!(
      mtpSetting?.controller_props as { value?: boolean } | undefined
    )?.value
    const eagle3Setting = provider.settings.find(
      (s) => s.key === 'eagle3_enabled'
    )
    const eagle3On = !!(
      eagle3Setting?.controller_props as { value?: boolean } | undefined
    )?.value
    if (!dflashOn && !mtpOn && !eagle3On) return

    const next = provider.settings.map((s) =>
      s.key === 'dflash_enabled' ||
      s.key === 'mtp_enabled' ||
      s.key === 'eagle3_enabled'
        ? {
            ...s,
            controller_props: {
              ...s.controller_props,
              value: false as never,
            },
          }
        : s
    )
    serviceHub.providers().updateSettings(providerName, next)
    updateProvider(providerName, { ...provider, settings: next })
  }, [activeMlxModelId, provider, providerName, serviceHub, updateProvider])

  /// ATO-54: the `llamacpp-upstream` `mtp` toggle is a PROVIDER-GLOBAL flag, so
  /// it stays on when the active model changes. Switching from an MTP-capable
  /// model to one without MTP layers left the Switch visually "on" even though
  /// the load-time capability gate (ATO-122, `performLoad`) silently dropped it
  /// — a confusing UI mismatch. Mirror the MLX reset-on-model-change effect
  /// above, but capability-aware: when the new active model is NOT MTP-capable
  /// we force `mtp` off (so the Switch reflects reality and the persisted flag
  /// can't drive a stale spec-decode arg); MTP-capable targets keep the value.
  const activeLlamacppUpstreamModelId = useMemo(() => {
    if (provider?.provider !== 'llamacpp-upstream') return undefined
    const upstreamIds = new Set(provider.models.map((m) => m.id))
    return activeModels.find((id) => upstreamIds.has(id))
  }, [activeModels, provider])

  const prevActiveLlamacppUpstreamModelRef = useRef<string | undefined>(
    undefined
  )
  useEffect(() => {
    if (provider?.provider !== 'llamacpp-upstream' || !provider) {
      prevActiveLlamacppUpstreamModelRef.current = undefined
      return
    }

    const prev = prevActiveLlamacppUpstreamModelRef.current
    prevActiveLlamacppUpstreamModelRef.current = activeLlamacppUpstreamModelId

    /// Skip the very first render and no-op changes (same as the MLX effect).
    if (prev === undefined) return
    if (prev === activeLlamacppUpstreamModelId) return

    const mtpSetting = provider.settings.find((s) => s.key === 'mtp')
    const mtpOn = !!(
      mtpSetting?.controller_props as { value?: boolean } | undefined
    )?.value
    if (!mtpOn) return

    /// No active model after the switch → can't evaluate capability; leave the
    /// flag (nothing is running, so there is no mismatch to surface yet).
    const modelId = activeLlamacppUpstreamModelId
    if (!modelId) return

    let cancelled = false
    const reconcile = async () => {
      /// Match `handleToggleLlamacppMtp` and the load gate: inspect canonical
      /// GGUF metadata for a built-in Qwen MTP head, then check the separate
      /// Gemma 4 draft registry.
      let capable = false
      try {
        const engine = EngineManager.instance().get('llamacpp-upstream') as {
          checkEmbeddedMtpSupport?: (id: string) => Promise<boolean>
          checkGemmaMtpSupport?: (id: string) => Promise<boolean>
        } | null
        capable =
          ((await engine?.checkEmbeddedMtpSupport?.(modelId)) ?? false) ||
          ((await engine?.checkGemmaMtpSupport?.(modelId)) ?? false)
      } catch {
        capable = false
      }
      if (cancelled || capable) return

      const next = provider.settings.map((s) =>
        s.key === 'mtp'
          ? {
              ...s,
              controller_props: {
                ...s.controller_props,
                value: false as never,
              },
            }
          : s
      )
      serviceHub.providers().updateSettings(providerName, next)
      updateProvider(providerName, { ...provider, settings: next })
    }
    void reconcile()
    return () => {
      cancelled = true
    }
  }, [
    activeLlamacppUpstreamModelId,
    provider,
    providerName,
    serviceHub,
    updateProvider,
  ])

  // Auto-refresh provider settings to get updated backend configuration
  const refreshSettings = useCallback(async () => {
    if (!provider) return

    try {
      // Refresh providers to get updated settings from the extension
      const updatedProviders = await serviceHub.providers().getProviders()
      setProviders(updatedProviders)
    } catch (error) {
      console.error('Failed to refresh settings:', error)
    }
  }, [provider, serviceHub, setProviders])

  // Auto-refresh settings when provider changes or when llamacpp needs backend config
  useEffect(() => {
    if (provider && needsBackendConfig) {
      // Auto-refresh every 3 seconds when backend is being configured
      const intervalId = setInterval(refreshSettings, 3000)
      return () => clearInterval(intervalId)
    }
  }, [provider, needsBackendConfig, refreshSettings])

  // Note: settingsChanged event is now handled globally in GlobalEventHandler
  // This ensures all screens receive the event intermediately

  // Auto-load models for loopback providers (Ollama, LM Studio, custom
  // self-hosted OpenAI-compatible servers, …). Their catalog is dynamic —
  // whatever the user runs locally — so we silently probe /v1/models instead
  // of forcing a manual Refresh. This fires both on entry (built-in Ollama,
  // whose loopback base_url comes from the registry) AND when the user edits a
  // custom provider's Base URL to a loopback address. Errors are non-fatal and
  // the manual Refresh button remains available.
  const loopbackBaseUrl =
    provider &&
    !isLocalProvider(provider.provider) &&
    provider.base_url &&
    isLoopbackUrl(provider.base_url)
      ? provider.base_url
      : null

  useEffect(() => {
    if (!loopbackBaseUrl) return

    let cancelled = false

    // Debounce: editing the Base URL field char-by-char must not spam the
    // endpoint. We fetch only after typing settles (and re-fetch cleanly if
    // the URL changes again, since the timer is cleared on cleanup).
    const timer = setTimeout(() => {
      const prov = useModelProvider.getState().getProviderByName(providerName)
      if (cancelled || !prov) return

      const load = async () => {
        setRefreshingModels(true)
        try {
          const liveIds = await serviceHub
            .providers()
            .fetchModelsFromProvider(prov)
          if (cancelled) return

          const existing = new Set(prov.models.map((m) => m.id))
          const newModels = liveIds
            .filter((id) => !existing.has(id))
            .map((id) => ({
              id,
              model: id,
              name: id,
              capabilities: getModelCapabilities(prov.provider, id),
              version: '1.0',
            }))

          if (newModels.length > 0) {
            updateProvider(prov.provider, {
              ...prov,
              models: [...prov.models, ...newModels],
            })
          }
        } catch (err) {
          console.warn(
            `[providers:${providerName}] auto model load failed (non-fatal):`,
            err
          )
        } finally {
          if (!cancelled) setRefreshingModels(false)
        }
      }

      void load()
    }, 500)

    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [providerName, loopbackBaseUrl, serviceHub, updateProvider])

  const handleRefreshModels = async () => {
    if (!provider) return

    setRefreshingModels(true)
    try {
      // Step 1 — Pull the latest manifest from our remote registry on GitHub
      // (the curated source for known cloud providers).
      try {
        await useProviderRegistryStore.getState().refresh({ force: true })
      } catch (err) {
        console.warn(
          `[providers:${provider.provider}] registry refresh failed:`,
          err
        )
      }

      const state = useProviderRegistryStore.getState()
      if (state.error) {
        toast.error(t('providers:models'), {
          description: state.error,
        })
        return
      }

      // Count models that will newly appear on this provider after the
      // registry merge — for the success toast.
      const fresh = await serviceHub.providers().getProviders()
      const registryProvider = fresh.find(
        (p) => p.provider === provider.provider
      )
      const existingIds = new Set(provider.models.map((m) => m.id))
      let newCount = registryProvider
        ? registryProvider.models.filter((m) => !existingIds.has(m.id)).length
        : 0

      // Step 2 — Hybrid: also query the provider's live /v1/models endpoint
      // (ATO-209). The registry only covers known cloud providers; custom /
      // self-hosted providers (vLLM, llama-server, LM Studio, etc.) are
      // invisible to the registry, so this is the only path that surfaces
      // their actual model list. We do it for all non-local providers that
      // have a base_url configured. Errors are non-fatal — if the live
      // endpoint is unavailable we still apply the registry results, but we
      // remember the error so the toast can warn instead of falsely claiming
      // "no new models" (ATO-210).
      //
      // P2 (ATO — registry-driven behavior): a registry provider may opt out
      // of live model listing via `supports_model_listing: false` (some clouds
      // expose hundreds of junk/internal IDs at /v1/models). When the flag is
      // explicitly false we show the curated registry list only and skip the
      // live probe. Missing/true keeps the hybrid behavior.
      let liveNewModels: Model[] = []
      let liveFetchError: Error | null = null
      const registrySupportsListing =
        registryProvider?.supports_model_listing !== false
      if (
        provider.base_url &&
        !isLocalProvider(provider.provider) &&
        registrySupportsListing
      ) {
        try {
          const liveModelIds = await serviceHub
            .providers()
            .fetchModelsFromProvider(provider)

          // Collect IDs already present after the registry pass so we only
          // add genuinely new entries.
          const afterRegistryIds = new Set([
            ...existingIds,
            ...(registryProvider?.models ?? []).map((m) => m.id),
          ])
          liveNewModels = liveModelIds
            .filter((id) => !afterRegistryIds.has(id))
            .map((id) => ({
              id,
              model: id,
              name: id,
              capabilities: getModelCapabilities(provider.provider, id),
              version: '1.0',
            }))

          if (liveNewModels.length > 0) newCount += liveNewModels.length

          console.info(
            `[providers:${provider.provider}] live /models: ${liveModelIds.length} total, ${liveNewModels.length} new`
          )
        } catch (liveErr) {
          // Non-fatal: registry results still apply even if the live
          // endpoint is unreachable or returns an error. We surface the error
          // in the toast below so the user knows the list may be incomplete.
          liveFetchError =
            liveErr instanceof Error ? liveErr : new Error(String(liveErr))
          console.warn(
            `[providers:${provider.provider}] live /models fetch failed (non-fatal):`,
            liveErr
          )
        }
      }

      // Apply the registry refresh. `setProviders` merges catalog updates while
      // preserving API keys, base URLs, and user-tweaked settings per provider,
      // and never removes existing models.
      setProviders(fresh)

      // Persist the live-discovered models onto THIS provider. We cannot inject
      // into `fresh` because custom / self-hosted providers (AIML, Cerebras,
      // LM Studio, vLLM, …) are NOT part of getProviders() output — they live
      // only in useModelProvider state, so the old `fresh.map()` injection
      // silently dropped them (toast said "Added N" but the list stayed empty).
      // updateProvider operates on current state and works for both registry
      // and custom providers.
      if (liveNewModels.length > 0) {
        const current =
          useModelProvider.getState().getProviderByName(provider.provider) ??
          provider
        // Dedupe by id (first-seen wins) so both newly fetched duplicates and
        // any duplicates already persisted from an earlier refresh collapse to
        // a single row.
        const byId = new Map<string, Model>()
        for (const m of [...current.models, ...liveNewModels]) {
          if (m.id && !byId.has(m.id)) byId.set(m.id, m)
        }
        updateProvider(provider.provider, { models: Array.from(byId.values()) })
      }

      if (newCount > 0) {
        toast.success(t('providers:models'), {
          description: t('providers:refreshModelsSuccess', {
            count: newCount,
            provider: provider.provider,
          }),
        })
      } else if (liveFetchError) {
        // Live fetch failed, so the "no new models" result may be incomplete —
        // warn with the underlying error instead of a misleading success.
        toast.warning(t('providers:models'), {
          description: t('providers:refreshModelsLiveFailed', {
            provider: provider.provider,
            error:
              liveFetchError.message ||
              t('providers:refreshModelsFailed', {
                provider: provider.provider,
              }),
          }),
        })
      } else {
        toast.success(t('providers:models'), {
          description: t('providers:noNewModels'),
        })
      }
    } catch (err) {
      console.error(`[providers:${provider.provider}] refresh failed:`, err)
      const detail =
        err instanceof Error && err.message
          ? err.message
          : t('providers:refreshModelsFailed', { provider: provider.provider })
      toast.error(t('providers:models'), {
        description: detail,
      })
    } finally {
      setRefreshingModels(false)
    }
  }

  const handleStartModel = async (modelId: string) => {
    if (!provider) return
    setLoadingModels((prev) => [...prev, modelId])
    try {
      // switchToModel stops all other models, starts this one, restarts the
      // server, and updates activeModels / loadingModel globally.
      await switchToModel({
        modelId,
        providerName: provider.provider,
        serviceHub,
      })
    } catch (error) {
      setModelLoadError(error as ErrorObject)
    } finally {
      setLoadingModels((prev) => prev.filter((id) => id !== modelId))
    }
  }

  const handleStopModel = async () => {
    if (!provider) return
    try {
      const isLocalEngine = isLocalProvider(provider.provider)
      if (isLocalEngine) {
        await serviceHub.models().stopAllModels()
      } else {
        // Cloud "stop": drop the proxy registration so incoming chat requests
        // for this provider's models stop being routed upstream. Local engines
        // are untouched; they can't be active for a cloud provider anyway.
        await unregisterRemoteProvider(provider.provider)
      }
      await window.core?.api?.stopServer()
      useAppState.getState().setServerStatus('stopped')
      if (isLocalEngine) {
        const models = await serviceHub
          .models()
          .getActiveModels(provider.provider)
        syncActiveModelsFromEngines(models || [])
      } else {
        // Remove any of this cloud provider's models from the active list
        // while leaving other providers' active entries intact.
        const providerModelIds = new Set(provider.models.map((m) => m.id))
        const remaining = useAppState
          .getState()
          .activeModels.filter((id) => !providerModelIds.has(id))
        setActiveModels(remaining)
      }
    } catch (error) {
      console.error('Error stopping model:', error)
    }
  }

  /// Toggle the DFlash speculative-decoding flag on the MLX provider.
  ///
  /// The toggle is a no-op metadata flip unless an MLX model is currently
  /// running: in that case we resolve the matching `z-lab/*-DFlash*` repo
  /// (auto-downloading it if needed) and restart the live session with
  /// the right CLI flags. Unsupported base models surface a modal popup.
  ///
  /// Mutex with MTP: if MTP is on and the user enables DFlash, we silently
  /// disable MTP first (single Switch flip → both flags reconciled).
  const handleToggleDflash = useCallback(
    async (nextEnabled: boolean) => {
      if (provider?.provider !== 'mlx' || !provider) return
      if (
        isTogglingDflash ||
        isDflashDownloading ||
        isTogglingMtp ||
        isMtpDownloading ||
        isTogglingEagle3 ||
        isEagle3Downloading
      )
        return

      const writeSetting = (key: string, value: unknown) => {
        const next = provider.settings.map((s) =>
          s.key === key
            ? {
                ...s,
                controller_props: {
                  ...s.controller_props,
                  value: value as never,
                },
              }
            : s
        )
        serviceHub.providers().updateSettings(providerName, next)
        updateProvider(providerName, { ...provider, settings: next })
      }

      const currentBlockSizeRaw = provider.settings.find(
        (s) => s.key === 'block_size'
      )?.controller_props?.value
      const currentBlockSize = Number(currentBlockSizeRaw) || 16

      const errTitle = t('settings:dflashEnableFailed', {
        defaultValue: 'Failed to toggle DFlash',
      })
      const noActive = t('settings:dflashNoActiveModel', {
        defaultValue: 'Start an MLX model first.',
      })

      const mlxEngine: any = EngineManager.instance().get('mlx')
      if (!mlxEngine) {
        toast.error(errTitle, { description: noActive })
        return
      }

      const loadedModels: string[] = (await mlxEngine.getLoadedModels?.()) ?? []
      const activeMlxModel = loadedModels[0]

      const mtpCurrentlyOn = !!(
        provider.settings.find((s) => s.key === 'mtp_enabled')
          ?.controller_props as { value?: boolean } | undefined
      )?.value
      const eagle3CurrentlyOn = !!(
        provider.settings.find((s) => s.key === 'eagle3_enabled')
          ?.controller_props as { value?: boolean } | undefined
      )?.value

      setIsTogglingDflash(true)
      try {
        if (nextEnabled) {
          if (!activeMlxModel) {
            toast.error(errTitle, { description: noActive })
            return
          }

          const support = await mlxEngine.checkDflashSupport(activeMlxModel)
          if (!support?.supported) {
            setDflashUnsupportedModel(activeMlxModel)
            return
          }

          /// Mutex: silently turn MTP off before enabling DFlash. The
          /// extension's `enableDflash` will also wipe `mtp_enabled` in
          /// its in-memory config, but we still need to flip the UI flag
          /// and run the server-side disable cleanly. We skip the
          /// `disableMtp` reload (a single MLX reload happens inside
          /// `enableDflash` instead) — only the metadata flips here.
          if (mtpCurrentlyOn) {
            writeSetting('mtp_enabled', false)
          }
          /// Same mutex against EAGLE-3 — `enableDflash` also wipes
          /// `eagle3_enabled` server-side; flip the UI flag here.
          if (eagle3CurrentlyOn) {
            writeSetting('eagle3_enabled', false)
          }

          /// When the draft is already cached on disk the MLX server can
          /// pick it up instantly — surface that as "Loading…" instead
          /// of misleading the user with "Downloading…".
          toast.info(
            support.local
              ? t('settings:dflashLoadingDraft', {
                  defaultValue: 'Loading DFlash draft for {{modelId}}...',
                  modelId: activeMlxModel,
                })
              : t('settings:dflashDownloadingDraft', {
                  defaultValue: 'Downloading DFlash draft for {{modelId}}...',
                  modelId: activeMlxModel,
                })
          )

          /// Hand off the long HF download to the dedicated state so the
          /// inline spinner disappears and the global DownloadManagement
          /// panel becomes the single source of truth for progress. The
          /// MLX reload that happens after the download still runs under
          /// `isTogglingDflash` (re-set in `finally`) and re-shows the
          /// spinner for the brief reload window.
          if (!support.local) {
            setIsDflashDownloading(true)
            setIsTogglingDflash(false)
          }

          try {
            /// Reuse the manifest from `checkDflashSupport` so the
            /// extension can skip the static lookup. The extension owns
            /// local-first resolution and direct-download fallback from
            /// here on.
            await mlxEngine.enableDflash(activeMlxModel, currentBlockSize, {
              repo: support.repo,
              required: support.required,
              optional: support.optional,
            })
          } finally {
            if (!support.local) setIsDflashDownloading(false)
          }
          writeSetting('dflash_enabled', true)

          toast.success(
            t('settings:dflashEnableSuccess', {
              defaultValue: 'DFlash enabled',
            })
          )
        } else {
          if (activeMlxModel) {
            await mlxEngine.disableDflash(activeMlxModel)
          }
          writeSetting('dflash_enabled', false)

          toast.success(
            t('settings:dflashDisableSuccess', {
              defaultValue: 'DFlash disabled',
            })
          )
        }
      } catch (error) {
        console.error('Failed to toggle DFlash:', error)
        toast.error(errTitle, {
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        setIsTogglingDflash(false)
      }
    },
    [
      provider,
      providerName,
      serviceHub,
      updateProvider,
      t,
      isTogglingDflash,
      isDflashDownloading,
      isTogglingMtp,
      isMtpDownloading,
      isTogglingEagle3,
      isEagle3Downloading,
    ]
  )

  /// Start an MLX model *with* its DFlash draft from the "DFlash unavailable"
  /// dialog: select it, stop any live session, download/attach the paired
  /// draft, then load via the shared `switchToModel` path — without navigating
  /// to a new chat. Routing through `switchToModel` (rather than a bare
  /// `startModel`) is what updates the global `activeModels` / `loadingModel` /
  /// server status, so the MLX Models tab actually reflects the loading →
  /// running model. The DFlash UI flag is flipped only after the load resolves,
  /// and the `startedWithDflashRef` guard keeps the reset effect from wiping it
  /// once the session becomes active.
  const handleStartWithDflash = useCallback(
    async (modelId: string) => {
      if (provider?.provider !== 'mlx' || !provider) return

      const errTitle = t('settings:dflashEnableFailed', {
        defaultValue: 'Failed to toggle DFlash',
      })
      const mlxEngine: any = EngineManager.instance().get('mlx')
      if (!mlxEngine) {
        toast.error(errTitle)
        return
      }

      const blockSizeRaw = provider.settings.find((s) => s.key === 'block_size')
        ?.controller_props?.value
      const blockSize = Number(blockSizeRaw) || 16

      setLoadingModels((prev) =>
        prev.includes(modelId) ? prev : [...prev, modelId]
      )
      try {
        useModelProvider.getState().selectModelProvider('mlx', modelId)

        const support = await mlxEngine.checkDflashSupport?.(modelId)
        if (support?.supported) {
          /// Stop any live session first so `enableDflash` only records the
          /// draft config (it reloads in place when a session already exists).
          /// `switchToModel` below then performs a single load that already
          /// carries `--draft-model`.
          await serviceHub.models().stopAllModels()
          await mlxEngine.enableDflash(modelId, blockSize, {
            repo: support.repo,
            required: support.required,
            optional: support.optional,
          })
          startedWithDflashRef.current = modelId
        }

        /// Use the shared switch path (not a bare `startModel`) so the global
        /// `activeModels` / `loadingModel` / server status update and the MLX
        /// Models tab reflects the loading → running model. It does not
        /// navigate to a new chat.
        await switchToModel({ modelId, providerName: 'mlx', serviceHub })

        /// Flip the UI flag only after the session is actually running with the
        /// draft, so the toggle never shows "on" while the model is still
        /// loading/downloading.
        if (support?.supported) {
          const next = provider.settings.map((s) =>
            s.key === 'dflash_enabled'
              ? {
                  ...s,
                  controller_props: {
                    ...s.controller_props,
                    value: true as never,
                  },
                }
              : s.key === 'mtp_enabled' || s.key === 'eagle3_enabled'
                ? {
                    ...s,
                    controller_props: {
                      ...s.controller_props,
                      value: false as never,
                    },
                  }
                : s
          )
          serviceHub.providers().updateSettings(providerName, next)
          updateProvider(providerName, { ...provider, settings: next })
          toast.success(
            t('settings:dflashEnableSuccess', {
              defaultValue: 'DFlash enabled',
            })
          )
        }
      } catch (error) {
        startedWithDflashRef.current = null
        console.error('Failed to start with DFlash:', error)
        toast.error(errTitle, {
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        setLoadingModels((prev) => prev.filter((id) => id !== modelId))
      }
    },
    [provider, providerName, serviceHub, updateProvider, t]
  )

  /// Toggle the MTP (Multi-Token Prediction) speculative-decoding flag on
  /// the MLX provider. Mirrors `handleToggleDflash` 1:1 against the
  /// `mlx-community/gemma-4-*-it-assistant-bf16` registry.
  ///
  /// Mutex with DFlash: if DFlash is on and the user enables MTP, we
  /// silently disable DFlash first.
  const handleToggleMtp = useCallback(
    async (nextEnabled: boolean) => {
      if (provider?.provider !== 'mlx' || !provider) return
      if (
        isTogglingMtp ||
        isMtpDownloading ||
        isTogglingDflash ||
        isDflashDownloading ||
        isTogglingEagle3 ||
        isEagle3Downloading
      )
        return

      const writeSetting = (key: string, value: unknown) => {
        const next = provider.settings.map((s) =>
          s.key === key
            ? {
                ...s,
                controller_props: {
                  ...s.controller_props,
                  value: value as never,
                },
              }
            : s
        )
        serviceHub.providers().updateSettings(providerName, next)
        updateProvider(providerName, { ...provider, settings: next })
      }

      const currentBlockSizeRaw = provider.settings.find(
        (s) => s.key === 'mtp_block_size'
      )?.controller_props?.value
      const currentBlockSize = Number(currentBlockSizeRaw) || 4

      const errTitle = t('settings:mtpEnableFailed', {
        defaultValue: 'Failed to toggle MTP',
      })
      const noActive = t('settings:mtpNoActiveModel', {
        defaultValue: 'Start an MLX model first.',
      })

      const mlxEngine: any = EngineManager.instance().get('mlx')
      if (!mlxEngine) {
        toast.error(errTitle, { description: noActive })
        return
      }

      const loadedModels: string[] = (await mlxEngine.getLoadedModels?.()) ?? []
      const activeMlxModel = loadedModels[0]

      const dflashCurrentlyOn = !!(
        provider.settings.find((s) => s.key === 'dflash_enabled')
          ?.controller_props as { value?: boolean } | undefined
      )?.value
      const eagle3CurrentlyOn = !!(
        provider.settings.find((s) => s.key === 'eagle3_enabled')
          ?.controller_props as { value?: boolean } | undefined
      )?.value

      setIsTogglingMtp(true)
      try {
        if (nextEnabled) {
          if (!activeMlxModel) {
            toast.error(errTitle, { description: noActive })
            return
          }

          const support = await mlxEngine.checkMtpSupport(activeMlxModel)
          if (!support?.supported) {
            setMtpUnsupportedModel(activeMlxModel)
            return
          }

          /// Mutex: silently turn DFlash off before enabling MTP. The
          /// single MLX reload happens inside `enableMtp`; here we only
          /// flip the UI flag.
          if (dflashCurrentlyOn) {
            writeSetting('dflash_enabled', false)
          }
          /// Same mutex against EAGLE-3.
          if (eagle3CurrentlyOn) {
            writeSetting('eagle3_enabled', false)
          }

          toast.info(
            support.local
              ? t('settings:mtpLoadingDraft', {
                  defaultValue: 'Loading MTP assistant for {{modelId}}...',
                  modelId: activeMlxModel,
                })
              : t('settings:mtpDownloadingDraft', {
                  defaultValue: 'Downloading MTP assistant for {{modelId}}...',
                  modelId: activeMlxModel,
                })
          )

          if (!support.local) {
            setIsMtpDownloading(true)
            setIsTogglingMtp(false)
          }

          try {
            await mlxEngine.enableMtp(activeMlxModel, currentBlockSize, {
              repo: support.repo,
              required: support.required,
              optional: support.optional,
            })
          } finally {
            if (!support.local) setIsMtpDownloading(false)
          }
          writeSetting('mtp_enabled', true)

          toast.success(
            t('settings:mtpEnableSuccess', {
              defaultValue: 'MTP enabled',
            })
          )
        } else {
          if (activeMlxModel) {
            await mlxEngine.disableMtp(activeMlxModel)
          }
          writeSetting('mtp_enabled', false)

          toast.success(
            t('settings:mtpDisableSuccess', {
              defaultValue: 'MTP disabled',
            })
          )
        }
      } catch (error) {
        console.error('Failed to toggle MTP:', error)
        toast.error(errTitle, {
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        setIsTogglingMtp(false)
      }
    },
    [
      provider,
      providerName,
      serviceHub,
      updateProvider,
      t,
      isTogglingMtp,
      isMtpDownloading,
      isTogglingDflash,
      isDflashDownloading,
      isTogglingEagle3,
      isEagle3Downloading,
    ]
  )

  /// Toggle the EAGLE-3 speculative-decoding flag on the MLX provider.
  /// Mirrors `handleToggleMtp` 1:1 against the `RedHatAI/*-speculator.eagle3`
  /// registry.
  ///
  /// Mutex with DFlash and MTP: if either is on and the user enables
  /// EAGLE-3, we silently disable them first (single Switch flip → all
  /// flags reconciled).
  const handleToggleEagle3 = useCallback(
    async (nextEnabled: boolean) => {
      if (provider?.provider !== 'mlx' || !provider) return
      if (
        isTogglingEagle3 ||
        isEagle3Downloading ||
        isTogglingMtp ||
        isMtpDownloading ||
        isTogglingDflash ||
        isDflashDownloading
      )
        return

      const writeSetting = (key: string, value: unknown) => {
        const next = provider.settings.map((s) =>
          s.key === key
            ? {
                ...s,
                controller_props: {
                  ...s.controller_props,
                  value: value as never,
                },
              }
            : s
        )
        serviceHub.providers().updateSettings(providerName, next)
        updateProvider(providerName, { ...provider, settings: next })
      }

      const currentBlockSizeRaw = provider.settings.find(
        (s) => s.key === 'eagle3_block_size'
      )?.controller_props?.value
      /// `0` is a valid value (= use the speculator's built-in depth), so
      /// fall back to 0 rather than a non-zero default.
      const parsedBlock = Number(currentBlockSizeRaw)
      const currentBlockSize = Number.isFinite(parsedBlock) ? parsedBlock : 0

      const errTitle = t('settings:eagle3EnableFailed', {
        defaultValue: 'Failed to toggle EAGLE-3',
      })
      const noActive = t('settings:eagle3NoActiveModel', {
        defaultValue: 'Start an MLX model first.',
      })

      const mlxEngine: any = EngineManager.instance().get('mlx')
      if (!mlxEngine) {
        toast.error(errTitle, { description: noActive })
        return
      }

      const loadedModels: string[] = (await mlxEngine.getLoadedModels?.()) ?? []
      const activeMlxModel = loadedModels[0]

      const dflashCurrentlyOn = !!(
        provider.settings.find((s) => s.key === 'dflash_enabled')
          ?.controller_props as { value?: boolean } | undefined
      )?.value
      const mtpCurrentlyOn = !!(
        provider.settings.find((s) => s.key === 'mtp_enabled')
          ?.controller_props as { value?: boolean } | undefined
      )?.value

      setIsTogglingEagle3(true)
      try {
        if (nextEnabled) {
          if (!activeMlxModel) {
            toast.error(errTitle, { description: noActive })
            return
          }

          const support = await mlxEngine.checkEagle3Support(activeMlxModel)
          if (!support?.supported) {
            setEagle3UnsupportedModel(activeMlxModel)
            return
          }

          /// Mutex: silently turn DFlash and MTP off before enabling
          /// EAGLE-3. The single MLX reload happens inside `enableEagle3`;
          /// here we only flip the UI flags.
          if (dflashCurrentlyOn) {
            writeSetting('dflash_enabled', false)
          }
          if (mtpCurrentlyOn) {
            writeSetting('mtp_enabled', false)
          }

          toast.info(
            support.local
              ? t('settings:eagle3LoadingDraft', {
                  defaultValue: 'Loading EAGLE-3 speculator for {{modelId}}...',
                  modelId: activeMlxModel,
                })
              : t('settings:eagle3DownloadingDraft', {
                  defaultValue:
                    'Downloading EAGLE-3 speculator for {{modelId}}...',
                  modelId: activeMlxModel,
                })
          )

          if (!support.local) {
            setIsEagle3Downloading(true)
            setIsTogglingEagle3(false)
          }

          try {
            await mlxEngine.enableEagle3(activeMlxModel, currentBlockSize, {
              repo: support.repo,
              required: support.required,
              optional: support.optional,
            })
          } finally {
            if (!support.local) setIsEagle3Downloading(false)
          }
          writeSetting('eagle3_enabled', true)

          toast.success(
            t('settings:eagle3EnableSuccess', {
              defaultValue: 'EAGLE-3 enabled',
            })
          )
        } else {
          if (activeMlxModel) {
            await mlxEngine.disableEagle3(activeMlxModel)
          }
          writeSetting('eagle3_enabled', false)

          toast.success(
            t('settings:eagle3DisableSuccess', {
              defaultValue: 'EAGLE-3 disabled',
            })
          )
        }
      } catch (error) {
        console.error('Failed to toggle EAGLE-3:', error)
        toast.error(errTitle, {
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        setIsTogglingEagle3(false)
      }
    },
    [
      provider,
      providerName,
      serviceHub,
      updateProvider,
      t,
      isTogglingEagle3,
      isEagle3Downloading,
      isTogglingMtp,
      isMtpDownloading,
      isTogglingDflash,
      isDflashDownloading,
    ]
  )

  /// Toggle the upstream-llama MTP flag (`--spec-type draft-mtp`). Qwen
  /// capability is read from canonical GGUF metadata; Gemma 4 uses a separate
  /// draft head downloaded by the extension.
  ///
  /// On enable, if a model is already running, we stop it and reload with
  /// the new args so the toggle takes effect immediately (parity with the
  /// MLX dflash UX). On disable, we do the same so the spec flags are
  /// dropped from the live process.
  const handleToggleLlamacppMtp = useCallback(
    async (nextEnabled: boolean) => {
      if (provider?.provider !== 'llamacpp-upstream' || !provider) return
      if (isTogglingLlamacppMtp) return

      const writeSetting = async (key: string, value: unknown) => {
        const next = provider.settings.map((s) =>
          s.key === key
            ? {
                ...s,
                controller_props: {
                  ...s.controller_props,
                  value: value as never,
                },
              }
            : s
        )
        await serviceHub.providers().updateSettings(providerName, next)
        updateProvider(providerName, { ...provider, settings: next })
      }

      const errTitle = t('settings:llamacppMtpToggleFailed', {
        defaultValue: 'Failed to toggle MTP',
      })

      const engine: any = EngineManager.instance().get('llamacpp-upstream')
      if (!engine) {
        toast.error(errTitle, {
          description: t('settings:llamacppMtpEngineMissing', {
            defaultValue: 'Llama.cpp engine is unavailable.',
          }),
        })
        return
      }

      const loadedModels: string[] = (await engine.getLoadedModels?.()) ?? []
      const activeModel = loadedModels[0]

      setIsTogglingLlamacppMtp(true)
      try {
        if (nextEnabled) {
          /// Capability check. Two MTP shapes are supported:
          ///  - Qwen built-in MTP: canonical GGUF metadata reports the embedded
          ///    NextN layers (head inside the same GGUF).
          ///  - Gemma 4 MTP (31B / 26B-A4B): needs a SEPARATE draft head GGUF
          ///    downloaded next to the model (PR #23398).
          /// If the loaded model id is neither, refuse the toggle and surface
          /// the popup — don't write the setting (the Switch stays off).
          if (activeModel) {
            const isQwenMtp =
              (await engine.checkEmbeddedMtpSupport?.(activeModel)) ?? false
            if (!isQwenMtp) {
              const isGemmaMtp =
                (await engine.checkGemmaMtpSupport?.(activeModel)) ?? false
              if (!isGemmaMtp) {
                setLlamacppMtpUnsupportedModel(activeModel)
                return
              }
              /// Gemma 4: download the draft head (idempotent) before
              /// enabling so the reload below can attach `--model-draft`.
              toast.info(
                t('settings:llamacppMtpDownloadingDraft', {
                  defaultValue: 'Downloading MTP draft head…',
                })
              )
              await engine.ensureGemmaMtpDraft?.(activeModel)
            }
          }
          await writeSetting('mtp', true)
        } else {
          await writeSetting('mtp', false)
        }

        /// Auto-restart the live session so the new --spec-type draft-mtp
        /// flag is actually applied (or removed). Skipped if nothing is
        /// running — the next manual start will pick up the flag.
        if (activeModel) {
          try {
            await restartLocalModel(serviceHub, providerName, activeModel)
          } catch (e) {
            console.error('Failed to reload after MTP toggle:', e)
            toast.error(errTitle, {
              description:
                e instanceof Error ? e.message : 'Failed to restart model.',
            })
            return
          }
        }

        toast.success(
          nextEnabled
            ? t('settings:llamacppMtpEnableSuccess', {
                defaultValue: 'MTP enabled',
              })
            : t('settings:llamacppMtpDisableSuccess', {
                defaultValue: 'MTP disabled',
              })
        )
      } catch (error) {
        console.error('Failed to toggle Llamacpp MTP:', error)
        toast.error(errTitle, {
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        setIsTogglingLlamacppMtp(false)
      }
    },
    [
      provider,
      providerName,
      serviceHub,
      updateProvider,
      t,
      isTogglingLlamacppMtp,
    ]
  )

  const handleToggleLlamacppDflash = useCallback(
    async (nextEnabled: boolean, draftQuant?: string) => {
      if (provider?.provider !== 'llamacpp-upstream' || !provider) return
      if (isTogglingLlamacppDflash) return

      const writeSettings = async (updates: Record<string, unknown>) => {
        const next = provider.settings.map((s) =>
          Object.prototype.hasOwnProperty.call(updates, s.key)
            ? {
                ...s,
                controller_props: {
                  ...s.controller_props,
                  value: updates[s.key] as never,
                },
              }
            : s
        )
        await serviceHub.providers().updateSettings(providerName, next)
        updateProvider(providerName, { ...provider, settings: next })
      }

      const errTitle = t('settings:llamacppDflashToggleFailed', {
        defaultValue: 'Failed to toggle DFlash',
      })

      const engine: any = EngineManager.instance().get('llamacpp-upstream')
      if (!engine) {
        toast.error(errTitle, {
          description: t('settings:llamacppDflashEngineMissing', {
            defaultValue: 'Llama.cpp engine is unavailable.',
          }),
        })
        return
      }

      const loadedModels: string[] = (await engine.getLoadedModels?.()) ?? []
      const activeModel = loadedModels[0]

      setIsTogglingLlamacppDflash(true)
      try {
        if (nextEnabled) {
          const backendSupportsDflash =
            (await engine.checkDflashBackendSupport?.()) ?? false
          if (!backendSupportsDflash) {
            toast.error(errTitle, {
              description: t('settings:llamacppDflashBackendUnsupported', {
                defaultValue:
                  'The selected Llama.cpp backend does not advertise DFlash support (--spec-type draft-dflash). Update or switch to a compatible backend before enabling DFlash.',
              }),
            })
            return
          }

          if (!activeModel) {
            toast.error(errTitle, {
              description: t('settings:llamacppDflashNoActiveModel', {
                defaultValue: 'Start a Llama.cpp model before enabling DFlash.',
              }),
            })
            return
          }

          const isSupported =
            (await engine.checkDflashSupport?.(activeModel)) ?? false
          if (!isSupported) {
            setLlamacppDflashUnsupportedModel(activeModel)
            return
          }

          if (!draftQuant) {
            const options: LlamacppDflashDraftOption[] =
              (await engine.listDflashDrafts?.(activeModel)) ?? []
            if (options.length === 0) {
              throw new Error(
                `No compatible DFlash draft quantizations found for "${activeModel}".`
              )
            }
            setLlamacppDflashDraftSelection({
              modelId: activeModel,
              options,
            })
            return
          }

          toast.info(
            t('settings:llamacppDflashDownloadingDraft', {
              defaultValue: 'Downloading {{quant}} DFlash draft model…',
              quant: draftQuant,
            })
          )
          await engine.ensureDflashDraft?.(activeModel, draftQuant)
          await writeSettings({ dflash: true, mtp: false })
        } else {
          await writeSettings({ dflash: false })
        }

        if (activeModel) {
          try {
            await engine.unload?.(activeModel)
          } catch (e) {
            console.warn('Failed to unload before DFlash restart:', e)
          }
          try {
            await serviceHub.models().startModel(provider, activeModel, true)
          } catch (e) {
            console.error('Failed to reload after DFlash toggle:', e)
            toast.error(errTitle, {
              description:
                e instanceof Error ? e.message : 'Failed to restart model.',
            })
            return
          }
        }

        toast.success(
          nextEnabled
            ? t('settings:llamacppDflashEnableSuccess', {
                defaultValue: 'DFlash enabled',
              })
            : t('settings:llamacppDflashDisableSuccess', {
                defaultValue: 'DFlash disabled',
              })
        )
      } catch (error) {
        console.error('Failed to toggle Llamacpp DFlash:', error)
        toast.error(errTitle, {
          description: error instanceof Error ? error.message : 'Unknown error',
        })
      } finally {
        setIsTogglingLlamacppDflash(false)
      }
    },
    [
      provider,
      providerName,
      serviceHub,
      updateProvider,
      t,
      isTogglingLlamacppDflash,
    ]
  )

  const handleInstallBackendFromFile = useCallback(async () => {
    // On Windows/Linux the local llama.cpp provider id is `llamacpp-upstream`
    // (`LOCAL_LLAMACPP_PROVIDER`), not `llamacpp`. The button is rendered for
    // it, so the guard must accept it too — otherwise the click is a no-op
    // ("does nothing") on those platforms (ATO-95).
    if (
      provider?.provider !== 'llamacpp' &&
      provider?.provider !== LOCAL_LLAMACPP_PROVIDER &&
      provider?.provider !== 'mlx'
    )
      return

    setIsInstallingBackend(true)
    try {
      // Open file dialog with filter for .tar.gz and .zip files
      const selectedFile = await serviceHub.dialog().open({
        multiple: false,
        directory: false,
        filters: [
          {
            name: 'Backend Archives',
            extensions: ['tar.gz', 'zip', 'gz'],
          },
        ],
      })

      if (selectedFile && typeof selectedFile === 'string') {
        // Process the file path: replace spaces with dashes and convert to lowercase

        // Install the backend using the llamacpp extension
        await installBackend(selectedFile)

        // Extract filename from the selected file path and replace spaces with dashes
        const fileName = basenameNoExt(selectedFile).replace(/\s+/g, '-')

        // Capitalize provider name for display
        const providerDisplayName =
          provider?.provider === 'mlx' ? 'MLX' : 'Llamacpp'

        toast.success(t('settings:backendInstallSuccess'), {
          description: `${providerDisplayName} ${fileName} installed`,
        })

        // Refresh settings to update backend configuration
        await refreshSettings()
      }
    } catch (error) {
      console.error('Failed to install backend from file:', error)
      toast.error(t('settings:backendInstallError'), {
        description:
          error instanceof Error ? error.message : 'Unknown error occurred',
      })
    } finally {
      setIsInstallingBackend(false)
    }
  }, [provider, serviceHub, refreshSettings, t, installBackend])

  /// The version list and the release index are both fetched during the
  /// extension's `onLoad()`, so a fork release published while the app was
  /// open stays invisible until a restart. This button refetches the index and
  /// installs the newest stable release of the backend type in use.
  ///
  /// Shaped like `handleFindOptimalBackend`: the awaited part is only the
  /// bounded check, and the download runs detached. Awaiting the transfer here
  /// would pin the button in its loading state for the whole archive.
  const handleCheckEngineUpdate = useCallback(async () => {
    if (
      provider?.provider !== 'llamacpp' &&
      provider?.provider !== LOCAL_LLAMACPP_PROVIDER
    )
      return

    setIsCheckingEngineUpdate(true)
    try {
      const { updateAvailable, targetBackend } = await checkForEngineUpdate()
      if (!updateAvailable || !targetBackend) {
        toast.success(t('settings:noBackendUpdateAvailable'))
        return
      }

      toast.info(t('settings:backendUpdater.downloadingBackend'), {
        description: targetBackend,
      })
      void downloadRecommendedBackend(targetBackend)
        .then(async () => {
          // Report the outcome off the extension's own state. A successful
          // hot-swap has already appended the new option and announced the new
          // value, so re-reading the provider is all this needs — rebuilding the
          // whole catalog first (a full `configureBackends()`: manifest refetch
          // plus a device probe) used to hold the confirmation back by about
          // ten seconds after the transfer had finished, which read as "it
          // downloaded but did not switch".
          await refreshSettings()
          toast.success(t('settings:backendUpdater.updateSuccess'), {
            description: targetBackend,
          })

          // Still rebuild the catalog, just not on the critical path: when the
          // hot-swap fell back to the pending-restart flow, this is what makes
          // the freshly installed release selectable in the dropdown.
          void refreshBackendCatalog()
            .then(() => refreshSettings())
            .catch((err) => {
              console.warn('Backend catalog refresh failed:', err)
            })
        })
        .catch((err) => {
          console.error('Engine update download failed:', err)
          toast.error(t('settings:backendUpdater.downloadFailed'))
        })
    } catch (error) {
      console.error('Failed to check for engine updates:', error)
      toast.error(t('settings:backendUpdateError'), {
        description:
          error instanceof Error ? error.message : 'Unknown error occurred',
      })
    } finally {
      setIsCheckingEngineUpdate(false)
    }
  }, [
    provider,
    checkForEngineUpdate,
    downloadRecommendedBackend,
    refreshBackendCatalog,
    refreshSettings,
    t,
  ])

  /// Manual replacement for the legacy auto-popup: re-runs hardware
  /// detection on demand and, when a better backend is available,
  /// immediately kicks off the download. The user explicitly asked
  /// to find AND install — surfacing an extra confirmation dialog
  /// would just add a wasted click.
  ///
  /// UI surfaces:
  ///   - `Checking…` spinner replaces the button label only during
  ///     the (fast) detection phase. Once detection resolves we
  ///     return the button to idle and let the global
  ///     `<BackendUpdater />` dialog (mounted in `__root.tsx`) show
  ///     `downloading` → `restart-required` progress via the shared
  ///     `useBackendUpdater` event-driven state.
  ///
  /// Only meaningful for the llama.cpp provider on Windows / Linux —
  /// the macOS turboquant pipeline doesn't expose alternate backend
  /// types here.
  const handleFindOptimalBackend = useCallback(async () => {
    // The optimal-backend matrix exists for the local llama.cpp engines:
    // the upstream provider (`LOCAL_LLAMACPP_PROVIDER`) on every desktop OS,
    // plus the turboquant provider (`llamacpp`) which ships its own catalog
    // on Windows/Linux. Anything else is a remote provider with no per-host
    // backend variants.
    const isOptimalCapable =
      provider?.provider === LOCAL_LLAMACPP_PROVIDER ||
      (provider?.provider === 'llamacpp' && (IS_WINDOWS || IS_LINUX))
    if (!isOptimalCapable) return
    setIsRecheckingBackend(true)
    try {
      const result = await recheckOptimalBackend()
      if (!result) {
        toast.success(t('settings:backendUpdater.alreadyOptimal'))
        return
      }
      // Pass the freshly-detected backend explicitly: the hook's
      // internal `recommendation` state has been queued via
      // `setRecommendation(result)` inside `recheckOptimalBackend`
      // but React has not committed the re-render yet, so a
      // `downloadRecommendedBackend()` call without an argument
      // would still see the previous (often null) closure value and
      // silently bail.
      void downloadRecommendedBackend(result.recommendedBackend).catch(
        (err) => {
          console.error('Optimal backend download failed:', err)
          toast.error(t('settings:backendUpdater.downloadFailed'))
        }
      )
    } catch (error) {
      // ATO-161: distinguish "detection couldn't complete" (e.g. the
      // ggml-org release stream / api.github.com was unreachable, slow, or
      // rate-limited) from a genuine failure. The extension throws the
      // `BACKEND_DETECTION_FAILED` sentinel in that case; surface a calm,
      // actionable message and leave the current backend untouched instead
      // of the misleading "you're already on the optimal backend".
      if (
        error instanceof Error &&
        error.message === 'BACKEND_DETECTION_FAILED'
      ) {
        toast.info(t('settings:backendUpdater.detectionUnavailable'))
        return
      }
      console.error('Failed to recheck optimal backend:', error)
      toast.error(t('settings:backendUpdater.findOptimalFailed'))
    } finally {
      setIsRecheckingBackend(false)
    }
  }, [provider, recheckOptimalBackend, downloadRecommendedBackend, t])

  /// "Find optimal backend" stays busy until the whole pipeline is done:
  /// detection → download → hot-swap. Without this, the local
  /// `isRecheckingBackend` flips back to false the moment detection
  /// resolves (a few ms), so the spinner appears to flicker even though
  /// the heavy lifting is still going on inside `useBackendUpdater`.
  const isOptimalBackendBusy =
    isRecheckingBackend ||
    recommendationPhase === 'downloading' ||
    recommendationPhase === 'hotswapping'

  const optimalBackendLabel = isRecheckingBackend
    ? t('settings:backendUpdater.findOptimalChecking')
    : recommendationPhase === 'downloading'
      ? t('settings:backendUpdater.findOptimalDownloading')
      : recommendationPhase === 'hotswapping'
        ? t('settings:backendUpdater.findOptimalSwitching')
        : t('settings:backendUpdater.findOptimalAction')

  return (
    <div className="flex flex-col h-svh w-full">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <span className="font-medium text-base font-studio">
            {t('common:settings')}
          </span>
        </div>
      </HeaderPage>
      <div className="flex h-[calc(100%-60px)]">
        <SettingsMenu />
        <div className="p-4 pt-0 w-full overflow-y-auto">
          <div className="flex flex-col justify-between gap-4 gap-y-3 w-full">
            <div className="flex items-center justify-between">
              <h1 className="font-medium text-base">
                {getProviderTitle(providerName)}
              </h1>
              <Switch
                checked={provider?.active ?? false}
                onCheckedChange={(checked) =>
                  provider && updateProvider(providerName, { active: checked })
                }
              />
            </div>

            <div
              className={cn(
                'flex flex-col gap-3',
                provider &&
                  (provider.provider === 'llamacpp' ||
                    provider.provider === 'llamacpp-upstream' ||
                    provider.provider === 'mlx') &&
                  'flex-col-reverse'
              )}
            >
              {/* Settings */}
              <Card>
                {provider?.settings.map((setting, settingIndex) => {
                  // Concurrent Mode acts as a master toggle over `parallel`,
                  // `cont_batching` and `expose_metrics`. When it's on, those
                  // rows are visually dimmed to signal they're managed.
                  const concurrentModeOn = !!(
                    provider?.settings.find((s) => s.key === 'concurrent_mode')
                      ?.controller_props as { value?: boolean } | undefined
                  )?.value
                  const isManagedByConcurrentMode =
                    concurrentModeOn &&
                    (setting.key === 'parallel' ||
                      setting.key === 'cont_batching' ||
                      setting.key === 'expose_metrics')
                  // Concurrent Slots only makes sense when Concurrent Mode is
                  // on; hide the row entirely otherwise to reduce clutter.
                  const isHiddenByConcurrentMode =
                    !concurrentModeOn && setting.key === 'concurrent_slots'

                  // The DFlash speculative-decoding toggle is the master
                  // switch over `block_size`; the MTP toggle does the
                  // same for `mtp_block_size`. Hide the corresponding
                  // block-size row when its master switch is off so the
                  // panel stays uncluttered.
                  const dflashEnabledOn = !!(
                    provider?.settings.find(
                      (s) => s.key === 'dflash_enabled' || s.key === 'dflash'
                    )?.controller_props as { value?: boolean } | undefined
                  )?.value
                  const mtpEnabledOn = !!(
                    provider?.settings.find((s) => s.key === 'mtp_enabled')
                      ?.controller_props as { value?: boolean } | undefined
                  )?.value
                  const eagle3EnabledOn = !!(
                    provider?.settings.find((s) => s.key === 'eagle3_enabled')
                      ?.controller_props as { value?: boolean } | undefined
                  )?.value
                  const isHiddenByDflash =
                    (!dflashEnabledOn && setting.key === 'block_size') ||
                    (!dflashEnabledOn && setting.key === 'dflash_block_size') ||
                    (!mtpEnabledOn && setting.key === 'mtp_block_size') ||
                    (!eagle3EnabledOn && setting.key === 'eagle3_block_size')

                  // The dflash_enabled / mtp_enabled / eagle3_enabled
                  // checkboxes are rendered as Switches with custom
                  // side-effecting handlers that reload the live MLX
                  // session, so we short-circuit the generic
                  // DynamicControllerSetting path for them.
                  const isDflashToggle = setting.key === 'dflash_enabled'
                  const isMtpToggle = setting.key === 'mtp_enabled'
                  const isEagle3Toggle = setting.key === 'eagle3_enabled'
                  /// Upstream llama.cpp uses the bare key `mtp` (set in
                  /// extensions/llamacpp-upstream-extension/settings.json).
                  /// The MLX MTP key is `mtp_enabled`, so the two never
                  /// collide; we additionally gate by provider id for
                  /// defence-in-depth.
                  const isLlamacppMtpToggle =
                    setting.key === 'mtp' &&
                    provider?.provider === 'llamacpp-upstream'
                  const isLlamacppDflashToggle =
                    setting.key === 'dflash' &&
                    provider?.provider === 'llamacpp-upstream'

                  // Use the DynamicController component
                  const actionComponent = (
                    <div className="mt-2">
                      {needsBackendConfig &&
                      setting.key === 'version_backend' ? (
                        <div className="flex items-center gap-1 text-sm">
                          <IconLoader size={16} className="animate-spin" />
                          <span>loading</span>
                        </div>
                      ) : isDflashToggle ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={
                              !!(
                                setting.controller_props as {
                                  value?: boolean
                                }
                              ).value
                            }
                            /* Cross-disable while ANY speculative toggle
                               is busy — prevents racy double-flips that
                               would leave both flags true. */
                            disabled={
                              isTogglingDflash ||
                              isDflashDownloading ||
                              isTogglingMtp ||
                              isMtpDownloading ||
                              isTogglingEagle3 ||
                              isEagle3Downloading
                            }
                            onCheckedChange={(checked) => {
                              handleToggleDflash(checked)
                            }}
                          />
                          {/* Inline spinner is intentionally hidden while a
                              HF download is in flight — the left-panel
                              DownloadManagement widget owns that progress
                              UX. The spinner only covers the short MLX
                              reload window after the download. */}
                          {isTogglingDflash && (
                            <IconLoader
                              size={14}
                              className="animate-spin text-muted-foreground"
                            />
                          )}
                        </div>
                      ) : isMtpToggle ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={
                              !!(
                                setting.controller_props as {
                                  value?: boolean
                                }
                              ).value
                            }
                            disabled={
                              isTogglingMtp ||
                              isMtpDownloading ||
                              isTogglingDflash ||
                              isDflashDownloading ||
                              isTogglingEagle3 ||
                              isEagle3Downloading
                            }
                            onCheckedChange={(checked) => {
                              handleToggleMtp(checked)
                            }}
                          />
                          {isTogglingMtp && (
                            <IconLoader
                              size={14}
                              className="animate-spin text-muted-foreground"
                            />
                          )}
                        </div>
                      ) : isEagle3Toggle ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={
                              !!(
                                setting.controller_props as {
                                  value?: boolean
                                }
                              ).value
                            }
                            disabled={
                              isTogglingEagle3 ||
                              isEagle3Downloading ||
                              isTogglingMtp ||
                              isMtpDownloading ||
                              isTogglingDflash ||
                              isDflashDownloading
                            }
                            onCheckedChange={(checked) => {
                              handleToggleEagle3(checked)
                            }}
                          />
                          {isTogglingEagle3 && (
                            <IconLoader
                              size={14}
                              className="animate-spin text-muted-foreground"
                            />
                          )}
                        </div>
                      ) : isLlamacppDflashToggle ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={
                              !!(
                                setting.controller_props as {
                                  value?: boolean
                                }
                              ).value
                            }
                            disabled={
                              isTogglingLlamacppDflash || isTogglingLlamacppMtp
                            }
                            onCheckedChange={(checked) => {
                              handleToggleLlamacppDflash(checked)
                            }}
                          />
                          {isTogglingLlamacppDflash && (
                            <IconLoader
                              size={14}
                              className="animate-spin text-muted-foreground"
                            />
                          )}
                        </div>
                      ) : isLlamacppMtpToggle ? (
                        <div className="flex items-center gap-2">
                          <Switch
                            checked={
                              !!(
                                setting.controller_props as {
                                  value?: boolean
                                }
                              ).value
                            }
                            disabled={
                              isTogglingLlamacppMtp || isTogglingLlamacppDflash
                            }
                            onCheckedChange={(checked) => {
                              handleToggleLlamacppMtp(checked)
                            }}
                          />
                          {isTogglingLlamacppMtp && (
                            <IconLoader
                              size={14}
                              className="animate-spin text-muted-foreground"
                            />
                          )}
                        </div>
                      ) : (
                        <DynamicControllerSetting
                          controllerType={setting.controller_type}
                          controllerProps={setting.controller_props}
                          className={cn(
                            setting.key === 'device' && 'hidden',
                            isHiddenByConcurrentMode && 'hidden',
                            isHiddenByDflash && 'hidden'
                          )}
                          onChange={(newValue) => {
                            // Manual "Latest <variant>" picks carry a
                            // `latest/<backend>` sentinel. Route them through
                            // the same animated download → hot-swap flow as
                            // the "Find optimal backend" button instead of
                            // silently persisting the sentinel: resolve to a
                            // concrete release tag, surface the global
                            // <BackendUpdater /> dialog, download, and let
                            // updateBackend() persist + reflect the result
                            // back into this dropdown.
                            if (
                              setting.key === 'version_backend' &&
                              typeof newValue === 'string' &&
                              newValue.startsWith('latest/')
                            ) {
                              void selectManualBackend(newValue).catch(
                                (err) => {
                                  console.error(
                                    'Manual backend download failed:',
                                    err
                                  )
                                  toast.error(
                                    t('settings:backendUpdater.downloadFailed')
                                  )
                                }
                              )
                              return
                            }
                            if (provider) {
                              const newSettings = [...provider.settings]
                              // Handle different value types by forcing the type
                              // Use type assertion to bypass type checking

                              ;(
                                newSettings[settingIndex].controller_props as {
                                  value: string | boolean | number
                                }
                              ).value = newValue

                              // Concurrent Mode implies Prometheus /metrics:
                              // when the user turns the master toggle on,
                              // reflect the implicit expose_metrics=true in
                              // the UI so the Prometheus checkbox matches the
                              // server-side behaviour enforced in args.rs.
                              if (
                                setting.key === 'concurrent_mode' &&
                                newValue === true
                              ) {
                                const metricsIdx = newSettings.findIndex(
                                  (s) => s.key === 'expose_metrics'
                                )
                                if (metricsIdx !== -1) {
                                  (
                                    newSettings[metricsIdx]
                                      .controller_props as {
                                      value: boolean
                                    }
                                  ).value = true
                                }
                              }

                              // Create update object with updated settings
                              const updateObj: Partial<ModelProvider> = {
                                settings: newSettings,
                              }
                              // Check if this is an API key or base URL setting and update the corresponding top-level field
                              const settingKey = setting.key
                              if (
                                settingKey === 'api-key' &&
                                typeof newValue === 'string'
                              ) {
                                updateObj.api_key = newValue
                              } else if (
                                settingKey === 'base-url' &&
                                typeof newValue === 'string'
                              ) {
                                // Trim so a stray leading/trailing space (common
                                // on paste) doesn't leak into request URLs as
                                // `/v1 /models` → 404. Normalise the stored
                                // setting value too, not just the mirror field.
                                const trimmedUrl = newValue.trim()
                                ;(
                                  newSettings[settingIndex]
                                    .controller_props as {
                                    value: string | boolean | number
                                  }
                                ).value = trimmedUrl
                                updateObj.base_url = trimmedUrl
                              }

                              // Reset device setting to empty when backend version changes
                              if (settingKey === 'version_backend') {
                                const deviceSettingIndex =
                                  newSettings.findIndex(
                                    (s) => s.key === 'device'
                                  )

                                if (deviceSettingIndex !== -1) {
                                  (
                                    newSettings[deviceSettingIndex]
                                      .controller_props as {
                                      value: string
                                    }
                                  ).value = ''
                                }

                                // Reset llamacpp device activations when backend version changes
                                if (providerName === 'llamacpp') {
                                  // Refresh devices to update activation status from provider settings
                                  const { fetchDevices } =
                                    useLlamacppDevices.getState()
                                  fetchDevices()
                                }
                              }

                              updateProvider(providerName, {
                                ...provider,
                                ...updateObj,
                              })

                              if (
                                settingKey !== 'version_backend' &&
                                (providerName === 'llamacpp' ||
                                  providerName === 'llamacpp-upstream')
                              ) {
                                providerSettingsWriteRef.current =
                                  providerSettingsWriteRef.current
                                    .catch((error) => {
                                      console.error(
                                        'Previous provider settings update failed:',
                                        error
                                      )
                                    })
                                    .then(() =>
                                      serviceHub
                                        .providers()
                                        .updateSettings(
                                          providerName,
                                          updateObj.settings ?? []
                                        )
                                    )
                                debouncedRestartLlamacppModel(providerName)
                                return
                              }

                              serviceHub
                                .providers()
                                .updateSettings(
                                  providerName,
                                  updateObj.settings ?? []
                                )
                              serviceHub.models().stopAllModels()

                              // Refresh active models after stopping. Use
                              // the shared helper so cloud models tracked
                              // only in UI state aren't wiped.
                              serviceHub
                                .models()
                                .getActiveModels()
                                .then((models) =>
                                  syncActiveModelsFromEngines(models || [])
                                )
                            }
                          }}
                        />
                      )}
                    </div>
                  )

                  return (
                    <CardItem
                      key={settingIndex}
                      title={setting.title}
                      className={cn(
                        setting.key === 'device' && 'hidden',
                        isHiddenByConcurrentMode && 'hidden',
                        isHiddenByDflash && 'hidden',
                        isManagedByConcurrentMode &&
                          'opacity-60 pointer-events-none'
                      )}
                      column={
                        setting.controller_type === 'input' &&
                        setting.controller_props.type !== 'number'
                          ? true
                          : false
                      }
                      description={
                        <>
                          <RenderMarkdown
                            className="![>p]:text-muted-foreground select-none"
                            content={setting.description}
                            components={{
                              // Make links open in a new tab, with the
                              // product brand colour #1F7CFF.
                              a: ({ style, ...props }) => {
                                return (
                                  <a
                                    {...props}
                                    target="_blank"
                                    rel="noopener noreferrer"
                                    style={{ color: '#1F7CFF', ...style }}
                                  />
                                )
                              },
                              p: ({ ...props }) => (
                                <p {...props} className="mb-0!" />
                              ),
                            }}
                          />
                          {setting.key === 'concurrent_slots' &&
                            concurrentModeOn && (
                              <div className="mt-1 text-sm text-muted-foreground">
                                {t(
                                  'providers:llamacpp.concurrentMode.perSlotContextWarning'
                                )}
                              </div>
                            )}
                          {setting.key === 'version_backend' &&
                            setting.controller_props?.recommended && (
                              <div className="mt-1 text-sm text-muted-foreground">
                                <span className="font-medium">
                                  {setting.controller_props.recommended
                                    ?.split('/')
                                    .pop() ||
                                    setting.controller_props.recommended}
                                </span>
                                <span> is the recommended backend.</span>
                              </div>
                            )}
                          {setting.key === 'version_backend' &&
                            runningBackendNotice && (
                              <div className="mt-1 flex items-center gap-1.5 text-sm text-amber-600 dark:text-amber-500">
                                <IconAlertTriangle size={14} />
                                <span>{runningBackendNotice}</span>
                              </div>
                            )}
                          {setting.key === 'version_backend' &&
                            (provider?.provider === 'llamacpp' ||
                              provider?.provider === 'llamacpp-upstream' ||
                              provider?.provider === 'mlx') && (
                              <div className="mt-2 flex flex-wrap gap-2">
                                {/* The install and engine-update controls use
                                    the same fixed width so they read as one
                                    control group and never resize with their
                                    labels. */}
                                <Button
                                  variant="outline"
                                  size="sm"
                                  onClick={handleInstallBackendFromFile}
                                  disabled={isInstallingBackend}
                                  className="w-[16rem]"
                                >
                                  <IconUpload
                                    size={12}
                                    className={cn(
                                      'text-muted-foreground',
                                      isInstallingBackend && 'animate-pulse'
                                    )}
                                  />
                                  <span>
                                    {isInstallingBackend
                                      ? 'Installing Backend...'
                                      : 'Install Backend from File'}
                                  </span>
                                </Button>
                                {/* Engine updates land without an app
                                    release, but both the version list and
                                    the release index are snapshots taken at
                                    extension load, so a release published
                                    while the app was open stays invisible
                                    until this button refetches. Both local
                                    providers resolve their catalog from an
                                    index they can refetch: turboquant from
                                    the fork's release index, upstream from
                                    the atomic-chat-conf manifest. */}
                                {(provider?.provider === 'llamacpp' ||
                                  provider?.provider ===
                                    LOCAL_LLAMACPP_PROVIDER) && (
                                  <Button
                                    variant="outline"
                                    size="sm"
                                    onClick={handleCheckEngineUpdate}
                                    disabled={
                                      isCheckingEngineUpdate ||
                                      isOptimalBackendBusy
                                    }
                                    className="w-[16rem]"
                                  >
                                    {/* Only the icon reflects progress. A
                                        label that swapped to a longer
                                        "Checking…" string would resize the
                                        button mid-click and shift the row,
                                        and no floor width fixes that for
                                        every locale. */}
                                    {isCheckingEngineUpdate ? (
                                      <IconLoader
                                        size={12}
                                        className="animate-spin text-muted-foreground"
                                      />
                                    ) : (
                                      <IconRefresh
                                        size={12}
                                        className="text-muted-foreground"
                                      />
                                    )}
                                    <span>
                                      {t('settings:checkForBackendUpdates')}
                                    </span>
                                  </Button>
                                )}
                                {/* "Find optimal backend" replaces the
                                    legacy auto-popup nag — it runs the
                                    same hardware detection on demand and
                                    immediately starts the download when
                                    a better backend is available. The
                                    explicit min-width keeps layout
                                    stable when the label flips between
                                    "Find optimal backend" and the
                                    shorter "Checking…" loading state.
                                    Hidden on macOS because that platform
                                    uses the separate turboquant
                                    pipeline with no alternate backend
                                    matrix. */}
                                {/* Windows and Linux ship two local
                                    llama.cpp providers side-by-side: the
                                    default upstream `ggml-org/llama.cpp`
                                    (`LOCAL_LLAMACPP_PROVIDER`) and the
                                    turboquant fork (`llamacpp`) — see the
                                    2026-06-23 ADR. Both resolve their own
                                    backend catalog, so the button is shown
                                    for either. The `useBackendUpdater`
                                    instance was configured per-provider
                                    above so the recommendation routes to
                                    the right extension. */}
                                {(IS_WINDOWS || IS_LINUX) &&
                                  (provider?.provider ===
                                    LOCAL_LLAMACPP_PROVIDER ||
                                    provider?.provider === 'llamacpp') && (
                                    <Button
                                      variant="outline"
                                      size="sm"
                                      onClick={handleFindOptimalBackend}
                                      disabled={isOptimalBackendBusy}
                                      className="min-w-[12rem]"
                                    >
                                      {isOptimalBackendBusy ? (
                                        <IconLoader
                                          size={12}
                                          className="animate-spin text-muted-foreground"
                                        />
                                      ) : (
                                        <IconRocket
                                          size={12}
                                          className="text-muted-foreground"
                                        />
                                      )}
                                      <span>{optimalBackendLabel}</span>
                                    </Button>
                                  )}
                              </div>
                            )}
                          {/* Pending-backend banner: appears as soon as
                              the just-downloaded backend is sitting in
                              this provider's pending key and waiting
                              for `activatePendingBackend()` on the
                              next launch. The `version_backend`
                              setting itself can't be hot-swapped while
                              the llama-server is running, so without
                              this pill the user sees no change
                              between "I clicked Find optimal" and "I
                              restarted the app". */}
                          {setting.key === 'version_backend' &&
                            (provider?.provider === 'llamacpp' ||
                              provider?.provider === LOCAL_LLAMACPP_PROVIDER) &&
                            pendingBackend && (
                              <div className="mt-2 flex flex-wrap items-center gap-2 rounded-md border border-dashed border-emerald-500/40 bg-emerald-500/5 px-3 py-2 text-xs">
                                <span className="font-medium text-emerald-600 dark:text-emerald-400">
                                  {t(
                                    'settings:backendUpdater.pendingBackendLabel'
                                  )}
                                </span>
                                <code className="font-mono text-foreground/80">
                                  {pendingBackend}
                                </code>
                                <span className="text-muted-foreground">
                                  {t(
                                    'settings:backendUpdater.pendingBackendHint'
                                  )}
                                </span>
                                <Button
                                  variant="outline"
                                  size="sm"
                                  className="ml-auto"
                                  onClick={handleRestartForPendingBackend}
                                >
                                  <IconRefresh
                                    size={12}
                                    className="text-muted-foreground"
                                  />
                                  <span>
                                    {t('settings:backendUpdater.restartNow')}
                                  </span>
                                </Button>
                              </div>
                            )}
                        </>
                      }
                      actions={actionComponent}
                      // The version_backend dropdown can carry a very long
                      // value (turboquant ids like
                      // `turboquant-windows-x64-cuda-12.4-d86eb0b/windows-x64-cuda-12.4`).
                      // CardItem's action wrapper is `shrink-0` by default, so
                      // such a value blows the column past the panel's right
                      // edge. Let this one row's action shrink (the dropdown
                      // truncates) instead of overflowing.
                      classNameWrapperAction={
                        setting.key === 'version_backend'
                          ? 'shrink min-w-0'
                          : undefined
                      }
                    />
                  )
                })}

                <DeleteProvider provider={provider} />
              </Card>

              {/* Models */}
              <Card
                header={
                  <div className="flex items-center justify-between mb-4">
                    <h1 className="text-foreground font-medium text-base">
                      {t('providers:models')}
                    </h1>
                    <div className="flex items-center gap-2">
                      {provider &&
                        provider.provider !== 'llamacpp' &&
                        provider.provider !== 'llamacpp-upstream' &&
                        provider.provider !== 'mlx' && (
                          <>
                            <Button
                              variant="secondary"
                              size="icon-xs"
                              onClick={handleRefreshModels}
                              disabled={refreshingModels}
                            >
                              {refreshingModels ? (
                                <IconLoader
                                  size={18}
                                  className="text-muted-foreground animate-spin"
                                />
                              ) : (
                                <IconRefresh
                                  size={18}
                                  className="text-muted-foreground"
                                />
                              )}
                            </Button>
                            <DialogAddModel provider={provider} />
                          </>
                        )}
                      {provider &&
                        (provider.provider === 'llamacpp' ||
                          provider.provider === 'llamacpp-upstream' ||
                          provider.provider === 'mlx') &&
                        !hasDownloadedModels && (
                          <Button
                            variant="default"
                            size="sm"
                            className="min-w-[8rem] justify-center"
                            onClick={() =>
                              navigate({
                                to: route.hub.index,
                                search: {
                                  engine:
                                    provider.provider === 'mlx'
                                      ? 'mlx'
                                      : 'gguf',
                                },
                              })
                            }
                          >
                            <IconSearch size={18} />
                            <span>{t('providers:findModel')}</span>
                          </Button>
                        )}
                      {provider &&
                        (provider.provider === 'llamacpp' ||
                          provider.provider === 'llamacpp-upstream') && (
                          <ImportVisionModelDialog
                            provider={provider}
                            onSuccess={handleModelImportSuccess}
                            trigger={
                              <Button
                                variant="secondary"
                                size="sm"
                                className="min-w-[8rem] justify-center"
                              >
                                <IconFolderPlus
                                  size={18}
                                  className="text-muted-foreground"
                                />
                                <span>{t('providers:import')}</span>
                              </Button>
                            }
                          />
                        )}
                      {provider && provider.provider === 'mlx' && (
                        <ImportMlxModelDialog
                          provider={provider}
                          onSuccess={handleModelImportSuccess}
                          trigger={
                            <Button
                              variant="secondary"
                              size="sm"
                              className="min-w-[8rem] justify-center"
                            >
                              <IconFolderPlus
                                size={18}
                                className="text-muted-foreground"
                              />
                              <span>{t('providers:import')}</span>
                            </Button>
                          }
                        />
                      )}
                    </div>
                  </div>
                }
              >
                {provider?.models.filter((m) => m.id !== EMBEDDING_MODEL_ID)
                  .length ? (
                  provider?.models
                    .filter((m) => m.id !== EMBEDDING_MODEL_ID)
                    .map((model, modelIndex) => {
                      const capabilities = model.capabilities || []
                      return (
                        <CardItem
                          key={modelIndex}
                          title={
                            <div className="flex items-center gap-2">
                              <h1
                                className="font-medium line-clamp-1 max-w-[16rem] lg:max-w-[24rem] xl:max-w-none"
                                title={model.id}
                              >
                                {getModelDisplayName(model)}
                              </h1>
                              {model.source && (
                                <ModelSourceBadge source={model.source} />
                              )}
                              {model.missing && (
                                <MissingModelBadge source={model.source} />
                              )}
                              <Capabilities capabilities={capabilities} />
                            </div>
                          }
                          actions={
                            <div className="flex items-center gap-0.5">
                              {(() => {
                                // Favorite star sits on the far left of the
                                // action row, before the edit icon. The slot
                                // is always reserved so that toggling
                                // visibility (e.g. after entering an API key
                                // for a predefined cloud provider) doesn't
                                // shift the surrounding icons. For custom
                                // providers the star is always visible; for
                                // predefined providers it's only visible once
                                // an API key has been set.
                                if (!provider) return null
                                const isPredefined = isKnownProvider(
                                  provider.provider
                                )
                                const showFavorite =
                                  !isPredefined ||
                                  Boolean(provider.api_key?.length)
                                return (
                                  <div
                                    aria-hidden={!showFavorite}
                                    className={
                                      showFavorite
                                        ? undefined
                                        : 'invisible pointer-events-none'
                                    }
                                  >
                                    <FavoriteModelAction model={model} />
                                  </div>
                                )
                              })()}
                              <DialogEditModel
                                provider={provider}
                                modelId={model.id}
                              />
                              {model.settings && (
                                <ModelSetting
                                  provider={provider}
                                  model={model}
                                />
                              )}
                              <DialogDeleteModel
                                provider={provider}
                                modelId={model.id}
                              />
                              {provider &&
                                (() => {
                                  const isLocalEngine =
                                    provider.provider === 'llamacpp' ||
                                    provider.provider === 'llamacpp-upstream' ||
                                    provider.provider === 'mlx'
                                  // Cloud providers need an API key before
                                  // they can be "started" (registered with the
                                  // proxy). Local engines don't.
                                  const needsApiKey =
                                    !isLocalProvider(provider.provider) &&
                                    !provider.api_key &&
                                    !isKeylessRemoteProvider(provider)
                                  const isActive = activeModels.some(
                                    (activeModel) => activeModel === model.id
                                  )
                                  const isLoading = loadingModels.includes(
                                    model.id
                                  )

                                  if (isActive) {
                                    return (
                                      <div className="ml-2">
                                        <Button
                                          size="sm"
                                          variant="destructive"
                                          onClick={() => handleStopModel()}
                                        >
                                          {t('providers:stop')}
                                        </Button>
                                      </div>
                                    )
                                  }

                                  const startButton = (
                                    <Button
                                      size="sm"
                                      disabled={isLoading || needsApiKey}
                                      onClick={() => handleStartModel(model.id)}
                                    >
                                      {isLoading ? (
                                        <div className="flex items-center gap-2">
                                          <IconLoader
                                            size={16}
                                            className="animate-spin"
                                          />
                                        </div>
                                      ) : (
                                        t('providers:start')
                                      )}
                                    </Button>
                                  )

                                  return (
                                    <div className="ml-2">
                                      {needsApiKey && !isLocalEngine ? (
                                        <Tooltip>
                                          <TooltipTrigger asChild>
                                            <span>{startButton}</span>
                                          </TooltipTrigger>
                                          <TooltipContent>
                                            Add API key first
                                          </TooltipContent>
                                        </Tooltip>
                                      ) : (
                                        startButton
                                      )}
                                    </div>
                                  )
                                })()}
                            </div>
                          }
                        />
                      )
                    })
                ) : (
                  <div className="-mt-2">
                    <div className="flex items-center gap-2">
                      <h6 className="font-medium text-base">
                        {t('providers:noModelFound')}
                      </h6>
                    </div>
                    <p className="text-muted-foreground mt-1 text-xs leading-relaxed">
                      {t('providers:noModelFoundDesc')}
                      &nbsp;
                      <Link to={route.hub.index}>{t('common:hub')}</Link>
                    </p>
                  </div>
                )}
                {/* Show importing skeleton first if there's one */}
                {importingModel && (
                  <CardItem
                    key="importing-skeleton"
                    title={
                      <div className="flex items-center gap-2">
                        <div className="flex items-center gap-2 animate-pulse">
                          <div className="flex gap-2 px-2 py-1 rounded-full text-xs">
                            <IconLoader size={16} className="animate-spin" />
                            Importing...
                          </div>
                          <h1 className="font-medium line-clamp-1">
                            {importingModel}
                          </h1>
                        </div>
                      </div>
                    }
                  />
                )}
              </Card>
            </div>
          </div>
        </div>
      </div>
      <DflashUnsupportedDialog
        open={dflashUnsupportedModel !== null}
        onOpenChange={(open) => {
          if (!open) setDflashUnsupportedModel(null)
        }}
        modelId={dflashUnsupportedModel ?? ''}
        onStartWithDflash={handleStartWithDflash}
      />
      <Eagle3UnsupportedDialog
        open={eagle3UnsupportedModel !== null}
        onOpenChange={(open) => {
          if (!open) setEagle3UnsupportedModel(null)
        }}
        modelId={eagle3UnsupportedModel ?? ''}
      />
      <MtpUnsupportedDialog
        open={mtpUnsupportedModel !== null}
        onOpenChange={(open) => {
          if (!open) setMtpUnsupportedModel(null)
        }}
        modelId={mtpUnsupportedModel ?? ''}
      />
      <LlamacppMtpUnsupportedDialog
        open={llamacppMtpUnsupportedModel !== null}
        onOpenChange={(open) => {
          if (!open) setLlamacppMtpUnsupportedModel(null)
        }}
        modelId={llamacppMtpUnsupportedModel ?? ''}
      />
      <LlamacppDflashUnsupportedDialog
        open={llamacppDflashUnsupportedModel !== null}
        onOpenChange={(open) => {
          if (!open) setLlamacppDflashUnsupportedModel(null)
        }}
        modelId={llamacppDflashUnsupportedModel ?? ''}
      />
      <LlamacppDflashDraftDialog
        open={llamacppDflashDraftSelection !== null}
        onOpenChange={(open) => {
          if (!open) setLlamacppDflashDraftSelection(null)
        }}
        modelId={llamacppDflashDraftSelection?.modelId ?? ''}
        options={llamacppDflashDraftSelection?.options ?? []}
        onConfirm={(quant) => {
          void handleToggleLlamacppDflash(true, quant)
        }}
      />
    </div>
  )
}
