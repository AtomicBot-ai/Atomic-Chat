/* eslint-disable @typescript-eslint/no-explicit-any */
import {
  useEffect,
  useState,
  useRef,
  useMemo,
  useCallback,
  memo,
} from 'react'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useModelProvider } from '@/hooks/useModelProvider'
import { cn, getProviderTitle } from '@/lib/utils'
import {
  isCloudProvider,
  isLocalEngineProvider,
  isProviderConnected,
} from '@/lib/cloud-providers'
import { highlightFzfMatch } from '@/utils/highlight'
import {
  ModelSourceBadge,
  MissingModelBadge,
} from '@/components/ModelSourceBadge'
import {
  IconChevronDown,
  IconChevronLeft,
  IconChevronRight,
  IconLoader2,
  IconSettings,
  IconX,
} from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import ReasoningEffortPanel from '@/containers/ReasoningEffortPanel'
import { useReasoningEffort } from '@/hooks/useReasoningEffort'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { ActiveModelIndicator } from '@/containers/ActiveModelIndicator'
import { useAppState } from '@/hooks/useAppState'
import { ModelSupportStatus } from '@/containers/ModelSupportStatus'
import { Fzf } from 'fzf'
import { localStorageKey } from '@/constants/localStorage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useFavoriteModel } from '@/hooks/useFavoriteModel'
import { isKnownProvider } from '@/stores/provider-registry-store'
import { EMBEDDING_MODEL_ID } from '@/constants/models'
import { DEFAULT_CTX_LEN } from '@/lib/context-size'
import { useServiceHub } from '@/hooks/useServiceHub'
import { getLastUsedModel } from '@/utils/getModelToStart'
import { isLocalProvider } from '@/utils/registerRemoteProvider'
import { switchToModel } from '@/utils/switchModel'
import {
  compactModelDisplayName,
  qualifiedModelDisplayName,
} from '@/lib/model-display-name'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useRunSettingsPanel } from '@/stores/run-settings-panel-store'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { formatDownloadReadout } from '@/lib/downloadFormat'
import { cancelDownload } from '@/lib/downloadCancellation'
import {
  HuggingFacePicks,
  ModelPickerEmptyState,
} from '@/containers/ModelPickerDownloads'
import {
  AddCloudProviderDialog,
  type CloudProviderSaveResult,
} from '@/containers/dialogs/AddCloudProviderDialog'

/** The subscription the empty list offers by name — the reply gate's. */
const SUBSCRIPTION_PROVIDER = 'chatgpt'

/**
 * The empty panel is content-sized up to a hard viewport cap. The model card
 * owns its own scrollbar, like Welcome, so a short list never leaves a blank
 * floor while a long list never pushes the routes out of view.
 */
const EMPTY_PANEL_CLASS = 'h-[min(22rem,calc(100dvh-12rem))]'
const EMPTY_SEARCH_PANEL_CLASS = 'h-[min(22rem,calc(100dvh-12rem))]'

/**
 * Which providers may list models in the picker.
 *
 * Local engines may — they are the app's own runtimes. A cloud provider only
 * once it is actually connected: the registry ships every catalogue entry
 * `active: true`, so without this the picker is a wall of providers the user
 * never set up (the ChatGPT subscription among them) burying the ones they did.
 *
 * Custom providers are judged on their models, as they are everywhere else:
 * they may legitimately need no key.
 *
 * Eligible is not enough for a section: one is rendered only when it has a
 * model to pick (see `groupedItems`).
 */
const isPickerSection = (provider: ModelProvider): boolean =>
  isLocalEngineProvider(provider) ||
  isProviderConnected(provider) ||
  (!isKnownProvider(provider.provider) && provider.models.length > 0)

interface SearchableModel {
  provider: ModelProvider
  model: Model
  searchStr: string
  value: string
  highlightedId?: string
}

// Helper functions for localStorage
const setLastUsedModel = (provider: string, model: string) => {
  try {
    localStorage.setItem(
      localStorageKey.lastUsedModel,
      JSON.stringify({ provider, model })
    )
  } catch (error) {
    console.debug('Failed to set last used model in localStorage:', error)
  }
}

// Vision detection asks the backend whether an mmproj sidecar exists next to the
// model file. That answer cannot change while the app runs, so the result is
// cached per model id: opening the model list must not re-probe the whole
// llamacpp library every time.
const visionProbeCache = new Map<string, boolean>()

type DropdownModelProviderProps = {
  className?: string
  compact?: boolean
}

/**
 * What the panel shows. `main` is the model row with the effort slider under
 * it; `models` is the searchable list the row leads to. With nothing selected
 * yet the row would only say "Select a model", so the list opens straight away.
 */
type PickerView = 'main' | 'models'

const DropdownModelProvider = memo(function DropdownModelProvider({
  className,
  compact: compactOverride,
}: DropdownModelProviderProps) {
  const providers = useModelProvider((state) => state.providers)
  const getProviderByName = useModelProvider((state) => state.getProviderByName)
  const selectModelProvider = useModelProvider(
    (state) => state.selectModelProvider
  )
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const updateProvider = useModelProvider((state) => state.updateProvider)
  const [displayModel, setDisplayModel] = useState<string>('')
  const navigate = useNavigate()
  const { t } = useTranslation()
  const { favoriteModels } = useFavoriteModel()
  const serviceHub = useServiceHub()
  const downloads = useDownloadStore((state) => state.downloads)
  const localDownloadingModels = useDownloadStore(
    (state) => state.localDownloadingModels
  )
  const pausedDownloads = useDownloadStore((state) => state.pausedDownloads)

  // Search state
  const [open, setOpen] = useState(false)
  const [searchValue, setSearchValue] = useState('')
  const searchInputRef = useRef<HTMLInputElement>(null)
  const [view, setView] = useState<PickerView>(() =>
    selectedModel?.id ? 'main' : 'models'
  )
  const { levelLabel: effortLabel } = useReasoningEffort()
  // The pill holds its level while the panel is open: the slider inside
  // changes it on every step, and a label that follows makes the pill under
  // the panel twitch — and, since the panel hangs off the pill, the panel
  // with it. The row and heading inside track the drag; the pill catches up
  // on close.
  const [settledEffortLabel, setSettledEffortLabel] = useState(effortLabel)
  useEffect(() => {
    if (!open) setSettledEffortLabel(effortLabel)
  }, [open, effortLabel])

  // With the sidebar and run settings both open the composer is at its
  // narrowest, so the pill folds down to the model's mark; the name stays on
  // hover and in the panel. With nothing selected there is no mark to fold
  // down to, so "Select a model" stays.
  const leftBarOpen = useLeftPanel((state) => state.open)
  const rightBarOpen = useRunSettingsPanel((state) => state.isOpen)
  const compact =
    (compactOverride ?? (leftBarOpen && rightBarOpen)) && !!selectedModel?.id

  // Helper function to check if a model exists in providers
  // The persisted cloud selection is usable when its provider is on, still
  // connected, and still lists the model.
  const isCloudSelectionUsable = useCallback(
    (providerName: string, modelId: string) => {
      const provider = providers.find((p) => p.provider === providerName)
      if (!provider || provider.active === false) return false
      if (!isProviderConnected(provider)) return false
      return provider.models.some((m) => m.id === modelId)
    },
    [providers]
  )

  const checkModelExists = useCallback(
    (providerName: string, modelId: string) => {
      const provider = providers.find(
        (p) => p.provider === providerName && p.active
      )
      return provider?.models.find((m) => m.id === modelId)
    },
    [providers]
  )

  // Helper function to get context size from model settings
  const getContextSize = useCallback((): number => {
    if (!selectedModel?.settings?.ctx_len?.controller_props?.value) {
      return DEFAULT_CTX_LEN
    }
    return selectedModel.settings.ctx_len.controller_props.value as number
  }, [selectedModel?.settings?.ctx_len?.controller_props?.value])

  const probeVisionCapability = useCallback(
    async (modelId: string): Promise<boolean> => {
      const cached = visionProbeCache.get(modelId)
      if (cached !== undefined) return cached
      try {
        const hasVision = await serviceHub.models().checkMmprojExists(modelId)
        visionProbeCache.set(modelId, hasVision)
        return hasVision
      } catch (error) {
        console.debug('Error checking mmproj for model:', modelId, error)
        return false
      }
    },
    [serviceHub]
  )

  // One store write for the whole batch. Writing per model rewrote the entire
  // `providers` array once per detected model, re-rendering every subscriber
  // (including the open model list) each time.
  const applyVisionCapabilities = useCallback(
    (modelIds: string[]) => {
      if (modelIds.length === 0) return
      const provider = getProviderByName('llamacpp')
      if (!provider) return

      const targets = new Set(modelIds)
      let changed = false
      const updatedModels = provider.models.map((model) => {
        if (!targets.has(model.id)) return model
        const capabilities = model.capabilities || []
        // Respect a manually configured capability list.
        const hasUserConfiguredCapabilities =
          (model as any)._userConfiguredCapabilities === true
        if (capabilities.includes('vision') || hasUserConfiguredCapabilities) {
          return model
        }
        changed = true
        return {
          ...model,
          capabilities: [...capabilities, 'vision'],
          // Mark this as auto-detected, not user-configured
          _autoDetectedVision: true,
        } as any
      })

      if (changed) {
        updateProvider('llamacpp', { models: updatedModels })
      }
    },
    [getProviderByName, updateProvider]
  )

  // Function to check if a llamacpp model has vision capabilities and update model capabilities
  const checkAndUpdateModelVisionCapability = useCallback(
    async (modelId: string) => {
      if (await probeVisionCapability(modelId)) {
        applyVisionCapabilities([modelId])
      }
    },
    [probeVisionCapability, applyVisionCapabilities]
  )

  // Initialize model provider on first mount (no model selected yet)
  useEffect(() => {
    const initializeModel = async () => {
      if (selectedProvider && selectedModel) {
        // A cloud selection survives a launch with preload off (main.tsx). It
        // is only worth keeping while the provider can still answer: a key
        // removed in the meantime would let the composer send into a wall.
        if (
          !isLocalProvider(selectedProvider) &&
          !isCloudSelectionUsable(selectedProvider, selectedModel.id)
        ) {
          selectModelProvider('', '')
        }
        return
      }

      // Skip is an explicit choice to enter with no model this session. An
      // explicit selection above still wins; startup defaults must not undo Skip.
      if (useModelLoad.getState().modelSelectionDeferred) return

      // A deliberate unload leaves the composer empty, including on remount
      // or provider refresh. Last-used/preload must not undo that user choice.
      if (useAppState.getState().userStoppedModels.length > 0) return

      const { preloadModelOnStartup } = useGeneralSetting.getState()
      if (!preloadModelOnStartup) {
        // Preload is disabled: don't pre-select the last used model or
        // auto-pick the first local model. Only reflect a model that is
        // already actively running (e.g. started manually earlier in the
        // session); otherwise leave the selector blank.
        try {
          const activeModelIds = await serviceHub.models().getActiveModels()
          const activeModelId = activeModelIds?.[0]
          if (activeModelId) {
            const activeProvider = providers.find(
              (p) => p.active && p.models.some((m) => m.id === activeModelId)
            )
            if (activeProvider) {
              selectModelProvider(activeProvider.provider, activeModelId)
              setLastUsedModel(activeProvider.provider, activeModelId)
              return
            }
          }
        } catch (error) {
          console.debug('Error checking active models on startup:', error)
        }
        selectModelProvider('', '')
        return
      }

      const lastUsed = getLastUsedModel()
      if (lastUsed && checkModelExists(lastUsed.provider, lastUsed.model)) {
        selectModelProvider(lastUsed.provider, lastUsed.model)
        if (lastUsed.provider === 'llamacpp') {
          await serviceHub
            .models()
            .checkMmprojExistsAndUpdateOffloadMMprojSetting(
              lastUsed.model,
              updateProvider,
              getProviderByName
            )
          await checkAndUpdateModelVisionCapability(lastUsed.model)
        }
      } else {
        const localProvider = providers.find(
          (p) =>
            (p.provider === 'llamacpp-upstream' ||
              p.provider === 'llamacpp' ||
              p.provider === 'mlx') &&
            p.active &&
            p.models.length > 0
        )
        if (localProvider && localProvider.models.length > 0) {
          const firstModel = localProvider.models.find(
            (m) => m.id !== EMBEDDING_MODEL_ID
          )
          if (!firstModel) {
            selectModelProvider('', '')
            return
          }
          selectModelProvider(localProvider.provider, firstModel.id)
          setLastUsedModel(localProvider.provider, firstModel.id)
        } else {
          selectModelProvider('', '')
        }
      }
    }

    initializeModel()
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [
    providers,
    selectModelProvider,
    checkModelExists,
    updateProvider,
    getProviderByName,
    checkAndUpdateModelVisionCapability,
  ])

  // Update display model when selection changes
  useEffect(() => {
    if (selectedProvider && selectedModel) {
      setDisplayModel(compactModelDisplayName(selectedModel))
    } else {
      setDisplayModel(t('common:selectAModel'))
    }
  }, [selectedProvider, selectedModel, t])

  // The sweep only cares about llamacpp models whose vision support is still
  // unknown. Keying the effect on that id list rather than on `providers` also
  // stops a detected capability from writing back and re-triggering the sweep.
  const visionSweepIdsKey = useMemo(() => {
    const llamacppProvider = providers.find(
      (p) => p.provider === 'llamacpp' && p.active
    )
    if (!llamacppProvider) return ''
    return llamacppProvider.models
      .filter(
        (model) =>
          !(model.capabilities || []).includes('vision') &&
          (model as any)._userConfiguredCapabilities !== true
      )
      .map((model) => model.id)
      .join('\n')
  }, [providers])

  // Check vision capabilities for llamacpp models that have not been probed yet
  useEffect(() => {
    if (!open || !visionSweepIdsKey) return

    let cancelled = false
    const checkLlamacppModelsForVision = async () => {
      const unprobed = visionSweepIdsKey
        .split('\n')
        .filter((id) => !visionProbeCache.has(id))
      if (unprobed.length === 0) return

      const probed = await Promise.all(
        unprobed.map(
          async (id) => [id, await probeVisionCapability(id)] as const
        )
      )
      if (cancelled) return

      applyVisionCapabilities(
        probed.filter(([, hasVision]) => hasVision).map(([id]) => id)
      )
    }

    void checkLlamacppModelsForVision()
    return () => {
      cancelled = true
    }
  }, [open, visionSweepIdsKey, probeVisionCapability, applyVisionCapabilities])

  // Reset search value when dropdown closes
  const onOpenChange = useCallback(
    (open: boolean) => {
      setOpen(open)
      if (!open) {
        requestAnimationFrame(() => setSearchValue(''))
      } else {
        // Every opening starts from the model row; the list is a step in.
        setView(selectedModel?.id ? 'main' : 'models')
      }
    },
    [selectedModel?.id]
  )

  // The search field takes focus whenever the list comes into view — on an
  // opening that lands on it directly as well as on a step in from the row.
  useEffect(() => {
    if (!open || view !== 'models') return
    const timer = setTimeout(() => {
      searchInputRef.current?.focus()
    }, 100)
    return () => clearTimeout(timer)
  }, [open, view])

  // Clear search and focus input
  const onClearSearch = useCallback(() => {
    setSearchValue('')
    searchInputRef.current?.focus()
  }, [])

  // The cloud routes of the empty list open the same dialog the reply gate
  // and onboarding open. It lives beside the panel, not in it: the panel
  // closes as the dialog takes focus, and a dialog inside it would go too.
  const [cloudDialog, setCloudDialog] = useState<{
    open: boolean
    /** Set to land on one provider's sign-in instead of the gallery. */
    provider?: string
  }>({ open: false })

  const openCloudDialog = useCallback(
    (provider?: string) => {
      onOpenChange(false)
      setCloudDialog({ open: true, provider })
    },
    [onOpenChange]
  )

  // A key saved, or a subscription signed in: pick the provider's model the
  // way the reply gate does, and let `switchToModel` register it.
  const handleCloudConnected = useCallback(
    ({ providerName, modelId }: CloudProviderSaveResult) => {
      if (!modelId) return
      selectModelProvider(providerName, modelId)
      switchToModel({ modelId, providerName, serviceHub }).catch((error) => {
        console.error('[DropdownModelProvider] cloud switch failed:', error)
      })
    },
    [selectModelProvider, serviceHub]
  )

  // Create searchable items from all models
  const searchableItems = useMemo(() => {
    const items: SearchableModel[] = []

    providers.forEach((provider) => {
      if (!provider.active) return

      provider.models.forEach((modelItem) => {
        // Skip embedding models - they can't be used for chat
        if (modelItem.embedding || modelItem.id === EMBEDDING_MODEL_ID) return

        // Skip catalogue entries for providers the user has not set up.
        // `isProviderConnected` is the check, not a bare `api_key` test: a
        // subscription carries its token in the backend and a loopback server
        // (Ollama, LM Studio) needs none, so keying off `api_key` alone hid
        // their models even while they were signed in and serving.
        if (!isPickerSection(provider)) return

        const capabilities = modelItem.capabilities || []
        const capabilitiesString = capabilities.join(' ')
        const providerTitle = getProviderTitle(provider.provider)

        // Create search string with model id, provider, and capabilities
        const searchStr =
          `${modelItem.id} ${providerTitle} ${provider.provider} ${capabilitiesString}`.toLowerCase()

        items.push({
          provider,
          model: modelItem,
          searchStr,
          value: `${provider.provider}:${modelItem.id}`,
        })
      })
    })

    return items
  }, [providers])

  // Nothing to pick at all — no local model downloaded, no cloud provider
  // connected. The list is then the reply gate's download panel, whatever
  // is typed: a search has nothing local to filter and answers from
  // Hugging Face instead.
  const pickerEmpty = searchableItems.length === 0

  const activeDownloads = useMemo(() => {
    const rows = new Map<
      string,
      {
        id: string
        progress: number
        current: number
        total: number
        bytesPerSecond: number
        stage?: { kind: string; attempt: number; maxAttempts: number }
        paused: boolean
      }
    >()
    for (const [downloadKey, download] of Object.entries(downloads)) {
      const id = download.id || download.name || downloadKey
      rows.set(id, {
        id,
        progress: download.progress ?? 0,
        current: download.current ?? 0,
        total: download.total ?? 0,
        bytesPerSecond: download.speed?.bytesPerSecond ?? 0,
        stage: download.stage,
        paused: pausedDownloads.has(id),
      })
    }
    for (const id of localDownloadingModels) {
      if (!rows.has(id)) {
        rows.set(id, {
          id,
          progress: 0,
          current: 0,
          total: 0,
          bytesPerSecond: 0,
          paused: false,
        })
      }
    }
    return [...rows.values()]
  }, [downloads, localDownloadingModels, pausedDownloads])

  // Create Fzf instance for fuzzy search
  const fzfInstance = useMemo(() => {
    return new Fzf(searchableItems, {
      selector: (item) =>
        `${compactModelDisplayName(item.model)} ${item.model.id}`.toLowerCase(),
    })
  }, [searchableItems])

  // Get favorite models that are currently available
  const favoriteItems = useMemo(() => {
    const matched = searchableItems.filter((item) =>
      favoriteModels.some((fav) => fav.id === item.model.id)
    )
    // A model id can appear under more than one provider (e.g. llamacpp +
    // llamacpp-upstream). Favorites are keyed by model id, so collapse to a
    // single entry per id — otherwise nicknaming one copy makes the favorite
    // show twice (once as the nickname, once as the raw id). Prefer the copy
    // that carries a user nickname (model.displayName); keep first match
    // otherwise. Map.set on an existing key preserves insertion order.
    const byId = new Map<string, SearchableModel>()
    for (const item of matched) {
      const existing = byId.get(item.model.id)
      if (
        !existing ||
        (!existing.model.displayName && item.model.displayName)
      ) {
        byId.set(item.model.id, item)
      }
    }
    return Array.from(byId.values())
  }, [searchableItems, favoriteModels])

  // Filter models based on search value
  const filteredItems = useMemo(() => {
    if (!searchValue) return searchableItems

    return fzfInstance.find(searchValue.toLowerCase()).map((result) => {
      const item = result.item
      const positions = Array.from(result.positions) || []
      const highlightedId = highlightFzfMatch(
        item.model.id,
        positions,
        'text-accent'
      )

      return {
        ...item,
        highlightedId,
      }
    })
  }, [searchableItems, searchValue, fzfInstance])

  // Group filtered items by provider, excluding favorites when not searching
  const groupedItems = useMemo(() => {
    const groups: Record<string, SearchableModel[]> = {}

    if (!searchValue) {
      const activeProviders = providers
        .filter((p) => p.active && isPickerSection(p))
        .sort((a, b) => {
          // Local providers first. Empty sections are dropped below, so this
          // only ever orders engines that have something to pick.
          const aIsLocal = isLocalEngineProvider(a)
          const bIsLocal = isLocalEngineProvider(b)
          if (aIsLocal !== bIsLocal) return aIsLocal ? -1 : 1

          // Custom providers without API key but with models should be treated like "have API key"
          const aIsPredefined = isKnownProvider(a.provider)
          const bIsPredefined = isKnownProvider(b.provider)
          const aHasApiKeyOrCustomModel =
            (a.api_key?.length ?? 0) > 0 ||
            (!aIsPredefined && a.models.length > 0)
          const bHasApiKeyOrCustomModel =
            (b.api_key?.length ?? 0) > 0 ||
            (!bIsPredefined && b.models.length > 0)
          // Providers with API keys or custom with models filled second
          if (aHasApiKeyOrCustomModel && !bHasApiKeyOrCustomModel) return -1
          if (!aHasApiKeyOrCustomModel && bHasApiKeyOrCustomModel) return 1

          // Sort remaining by provider name
          return a.provider.localeCompare(b.provider)
        })

      activeProviders.forEach((provider) => {
        groups[provider.provider] = []
      })
    }

    // Add the filtered items to their respective groups
    filteredItems.forEach((item) => {
      const providerKey = item.provider.provider
      if (!groups[providerKey]) {
        groups[providerKey] = []
      }

      // When not searching, exclude favorite models from regular provider sections
      const isFavorite = favoriteModels.some((fav) => fav.id === item.model.id)
      if (!searchValue && isFavorite) return // Skip adding this item to regular provider section

      groups[providerKey].push(item)
    })

    // TurboQuant renders last, after every remote provider. Its title
    // ("llama.cpp turboquant") differs from upstream's ("llama.cpp") by a
    // single word, so the two headers sitting back to back read as a
    // duplicate entry. Moving the key here (rather than in the sort above)
    // keeps it at the bottom while searching too.
    const { llamacpp: turboquantGroup, ...otherGroups } = groups
    const ordered = turboquantGroup
      ? { ...otherGroups, llamacpp: turboquantGroup }
      : groups

    // A section is there to pick a model from. An engine with nothing to list
    // — MLX before its first download, a connected provider with an empty
    // catalogue, one whose only model sits in Favorites — is a bare header
    // pushing the engines that do have models down the list. Its settings
    // stay reachable from Settings.
    return Object.fromEntries(
      Object.entries(ordered).filter(([, items]) => items.length > 0)
    )
  }, [filteredItems, providers, searchValue, favoriteModels])

  const handleSelect = useCallback(
    async (searchableModel: SearchableModel) => {
      // Immediately update display to prevent double-click issues
      setDisplayModel(compactModelDisplayName(searchableModel.model))
      setSearchValue('')
      setOpen(false)

      // Optimistically update the global model-provider selection so the
      // provider avatar, capabilities and support-status icons re-render
      // instantly — without waiting for stopAllModels / server restart /
      // registerRemoteProvider to complete inside switchToModel. switchToModel
      // will call this again at the end (idempotent) once the switch is done.
      selectModelProvider(
        searchableModel.provider.provider,
        searchableModel.model.id
      )

      // Fire-and-forget llamacpp mmproj / vision capability checks. These must
      // not block the switch itself.
      if (searchableModel.provider.provider === 'llamacpp') {
        serviceHub
          .models()
          .checkMmprojExistsAndUpdateOffloadMMprojSetting(
            searchableModel.model.id,
            updateProvider,
            getProviderByName
          )
          .catch((error) => {
            console.debug(
              'Error checking mmproj for model:',
              searchableModel.model.id,
              error
            )
          })

        checkAndUpdateModelVisionCapability(searchableModel.model.id).catch(
          (error) => {
            console.debug(
              'Error checking vision capability for model:',
              searchableModel.model.id,
              error
            )
          }
        )
      }

      // Unified switch: stops current engine, (re)starts the Local API Server,
      // registers cloud providers, and synchronises global state.
      switchToModel({
        modelId: searchableModel.model.id,
        providerName: searchableModel.provider.provider,
        serviceHub,
      }).catch((error) => {
        console.error('[DropdownModelProvider] switchToModel failed:', error)
      })
    },
    [
      updateProvider,
      getProviderByName,
      checkAndUpdateModelVisionCapability,
      selectModelProvider,
      serviceHub,
    ]
  )

  const provider = getProviderByName(selectedProvider)
  const detailDisplayModel = selectedModel
    ? qualifiedModelDisplayName(selectedModel)
    : displayModel

  if (!providers.length) return null

  return (
    <Popover open={open} onOpenChange={onOpenChange}>
      {/* The composer pill: the model, with the reasoning level as its
          subtitle. Its width follows the label, and the panel anchors to its
          right edge so the mic and Send beside it hold still. The status dot
          (ATO-530) sits in the pill but outside the trigger — it is a button
          of its own, and a button cannot live inside another. */}
      <div
        data-testid="model-picker-pill-shell"
        className={cn(
          'inline-flex h-7 shrink-0 overflow-hidden rounded-full',
          compact ? 'w-20' : 'w-44',
          className
        )}
      >
        <div
          className="inline-flex h-7 w-full min-w-0 items-center rounded-full border bg-secondary/40 text-xs transition-colors duration-200 hover:bg-secondary/70"
        >
          <ActiveModelIndicator className="ml-1.5" />
          <PopoverTrigger asChild>
            <button
              type="button"
              title={selectedModel?.id ?? displayModel}
              aria-label={compact ? displayModel : undefined}
              data-test-id="model-picker-trigger"
              className={cn(
                'inline-flex h-full min-w-0 flex-1 items-center gap-1.5 rounded-full pr-2',
                selectedModel?.id ? 'pl-1.5' : 'pl-2.5'
              )}
            >
              {provider && (
                <div className="shrink-0">
                  <ProvidersAvatar provider={provider} className="size-4" />
                </div>
              )}
              {!compact && (
                <span
                  key={displayModel}
                  className={cn(
                    'truncate font-medium animate-in fade-in-0 duration-150',
                    !selectedModel?.id && 'text-muted-foreground'
                  )}
                >
                  {displayModel}
                </span>
              )}
              {settledEffortLabel && (
                <span className="text-muted-foreground shrink-0">
                  {settledEffortLabel}
                </span>
              )}
              <IconChevronDown
                size={14}
                className={cn(
                  'text-muted-foreground shrink-0 transition-transform duration-200 ease-out',
                  open && 'rotate-180'
                )}
              />
            </button>
          </PopoverTrigger>
        </div>
      </div>

      <PopoverContent
        className={cn(
          'w-70 p-0 backdrop-blur-2xl bg-background/95 border',
          view === 'main' &&
            'w-[min(22rem,calc(100dvw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-y-auto',
          view === 'models' &&
            cn(
              'w-[min(22rem,calc(100dvw-2rem))] max-h-[var(--radix-popover-content-available-height)] overflow-hidden',
              pickerEmpty
                ? searchValue.trim()
                  ? EMPTY_SEARCH_PANEL_CLASS
                  : EMPTY_PANEL_CLASS
                : 'h-[min(22rem,calc(100dvh-12rem))]'
            )
        )}
        align="end"
        side="top"
        sideOffset={8}
        avoidCollisions
        collisionPadding={32}
      >
        {view === 'main' ? (
          <div className="flex min-w-0 flex-col p-3">
            {/* The model row: what is selected, and the way into the list. */}
            <button
              type="button"
              aria-label={t('common:changeModel')}
              data-test-id="model-picker-change"
              onClick={() => setView('models')}
              className="flex w-full min-w-0 cursor-pointer items-center gap-2 rounded-sm py-1.5 text-left text-sm transition-colors duration-200 hover:bg-secondary/40"
            >
              {provider && (
                <div className="shrink-0">
                  <ProvidersAvatar provider={provider} />
                </div>
              )}
              <span
                title={detailDisplayModel}
                className={cn(
                  'min-w-0 flex-1 truncate font-medium',
                  !selectedModel?.id && 'text-muted-foreground'
                )}
              >
                {detailDisplayModel}
              </span>
              {/* No level here: the effort heading right below says it. */}
              <ModelSupportStatus
                modelId={selectedModel?.id}
                provider={selectedProvider}
                contextSize={getContextSize()}
                className="shrink-0"
              />
              <IconChevronRight
                size={16}
                className="text-muted-foreground ml-auto shrink-0"
              />
            </button>
            {/* Mounted with the panel, so a fresh open always starts settled. */}
            <ReasoningEffortPanel className="mt-2 min-w-0 border-t pt-3" />
          </div>
        ) : (
          <div
            className={cn(
              'flex min-h-0 flex-col',
              pickerEmpty && !searchValue.trim() ? 'w-full' : 'size-full'
            )}
          >
            {/* Search input, with the way back to the model row. */}
            <div className="relative flex shrink-0 items-center gap-1 p-1.5 border-b">
              <Button
                type="button"
                variant="ghost"
                size="icon-xs"
                aria-label={t('common:back')}
                onClick={() => setView('main')}
              >
                <IconChevronLeft size={16} className="text-muted-foreground" />
              </Button>
              <input
                ref={searchInputRef}
                value={searchValue}
                onChange={(e) => setSearchValue(e.target.value)}
                placeholder={t('common:searchModelsHuggingFace')}
                className="min-w-0 flex-1 pr-6 text-sm font-normal outline-0"
              />
              {searchValue.length > 0 && (
                <div className="absolute right-2 top-0 bottom-0 flex items-center justify-center">
                  <IconX
                    size={16}
                    className="text-muted-foreground cursor-pointer"
                    onClick={onClearSearch}
                  />
                </div>
              )}
            </div>

            {/* Model list. With nothing to pick it fills the panel's fixed
                height and scrolls inside it. */}
            <div className="min-h-0 flex-1 overflow-y-auto">
              <div className={cn(!pickerEmpty && 'py-1')}>
                {activeDownloads.length > 0 && (
                  <div
                    className="m-1.5 rounded-sm bg-secondary/30 py-1"
                    data-testid="model-picker-downloading"
                  >
                    <div className="px-2 py-1 text-xs font-medium text-muted-foreground">
                      {t('common:downloading')}
                    </div>
                    {activeDownloads.map((download) => {
                      return (
                        <div
                          key={download.id}
                          className="mx-1 flex min-w-0 items-center gap-2 rounded-sm px-2 py-1.5"
                        >
                          <IconLoader2 className="size-4 shrink-0 animate-spin text-muted-foreground" />
                          <div className="min-w-0 flex-1">
                            <div className="truncate text-sm" title={download.id}>
                              {qualifiedModelDisplayName({ id: download.id } as Model)}
                            </div>
                            <div className="truncate text-xs text-muted-foreground" title={formatDownloadReadout(t, download)}>
                              {formatDownloadReadout(t, download)}
                            </div>
                          </div>
                          <button
                            type="button"
                            className="h-auto shrink-0 cursor-pointer px-1 text-xs text-muted-foreground hover:text-foreground hover:underline underline-offset-4"
                            onClick={() =>
                              cancelDownload(
                                { id: download.id, name: download.id },
                                serviceHub
                              )
                            }
                          >
                            {t('common:cancel')}
                          </button>
                        </div>
                      )
                    })}
                  </div>
                )}
                {/* Favorites section - only show when not searching */}
                {!searchValue && favoriteItems.length > 0 && (
                  <div className="bg-secondary/30 rounded-sm m-2 py-1">
                    {/* Favorites header */}
                    <div className="flex items-center gap-1.5 px-2 py-1">
                      <span className="text-sm font-medium text-muted-foreground">
                        {t('common:favorites')}
                      </span>
                    </div>

                    {/* Favorite models */}
                    {favoriteItems.map((searchableModel) => {
                      const isSelected =
                        selectedModel?.id === searchableModel.model.id &&
                        selectedProvider === searchableModel.provider.provider

                      return (
                        <div
                          key={`fav-${searchableModel.value}`}
                          title={searchableModel.model.id}
                          onClick={() => handleSelect(searchableModel)}
                          className={cn(
                            'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
                            'hover:bg-secondary/40',
                            isSelected && 'bg-secondary/50'
                          )}
                        >
                          <div className="flex items-center gap-1 flex-1 min-w-0">
                            <div className="shrink-0 -ml-1">
                              <ProvidersAvatar
                                provider={searchableModel.provider}
                              />
                            </div>
                            <span className="text-sm truncate">
                              {qualifiedModelDisplayName(searchableModel.model)}
                            </span>
                            {searchableModel.model.source && (
                              <ModelSourceBadge
                                source={searchableModel.model.source}
                                className="shrink-0"
                              />
                            )}
                            {searchableModel.model.missing && (
                              <MissingModelBadge
                                source={searchableModel.model.source}
                                className="shrink-0"
                              />
                            )}
                            <span
                              aria-hidden="true"
                              className={cn(
                                'ml-auto flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                                isSelected
                                  ? 'border-blue-500'
                                  : 'border-muted-foreground/40'
                              )}
                              data-testid={`model-selection-${searchableModel.value}`}
                            >
                              {isSelected && (
                                <span className="size-2 rounded-full bg-blue-500" />
                              )}
                            </span>
                          </div>
                        </div>
                      )
                    })}
                  </div>
                )}

                {/* Divider between favorites and regular providers */}
                {favoriteItems.length > 0 && (
                  <div className="border-b mx-2"></div>
                )}

                {/* Regular provider sections */}
                {Object.entries(groupedItems).map(([providerKey, models]) => {
                  const providerInfo = providers.find(
                    (p) => p.provider === providerKey
                  )

                  if (!providerInfo) return null

                  return (
                    <div
                      key={providerKey}
                      className="bg-secondary/30 first:mt-0 rounded-sm my-1.5 mx-1.5 first:mb-0 py-1"
                    >
                      {/* Provider header */}
                      <div className="flex items-center justify-between gap-3 px-2 py-1">
                        {/* `min-w-0` on the group and the span is what lets
                            a long title ("ChatGPT subscription (Codex)")
                            ellipsise instead of wrapping and pushing the
                            dot and the gear off their line. */}
                        <div className="flex items-center gap-1.5 min-w-0 flex-1">
                          <ProvidersAvatar
                            provider={providerInfo}
                            className="size-4.5 shrink-0"
                          />
                          <span
                            className="text-sm font-medium text-muted-foreground min-w-0 truncate"
                            title={getProviderTitle(providerInfo.provider)}
                          >
                            {getProviderTitle(providerInfo.provider)}
                          </span>
                          {providerInfo.provider === selectedProvider && (
                            <span className="size-2 rounded-full bg-green-500 shrink-0" />
                          )}
                        </div>

                        <button
                          type="button"
                          aria-label={t('common:modelPicker.providerSettings', {
                            provider: getProviderTitle(providerInfo.provider),
                          })}
                          className="size-6 shrink-0 cursor-pointer flex items-center justify-center rounded-sm bg-transparent transition-colors duration-200 ease-in-out hover:bg-secondary-foreground/8 focus-visible:bg-secondary-foreground/8 focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
                          onClick={(e) => {
                            e.stopPropagation()
                            // Cloud providers are set up on `/cloud`; local
                            // engines keep their Settings detail page.
                            if (isCloudProvider(providerInfo)) {
                              navigate({
                                to: route.cloud.index,
                                search: { provider: providerInfo.provider },
                              })
                            } else {
                              navigate({
                                to: route.settings.providers,
                                params: {
                                  providerName: providerInfo.provider,
                                },
                              })
                            }
                            setOpen(false)
                          }}
                        >
                          <IconSettings
                            size={16}
                            className="text-muted-foreground"
                          />
                        </button>
                      </div>

                      {/* Models for this provider */}
                      {models.map((searchableModel) => {
                        const isSelected =
                          selectedModel?.id === searchableModel.model.id &&
                          selectedProvider === searchableModel.provider.provider

                        return (
                          <div
                            key={searchableModel.value}
                            title={searchableModel.model.id}
                            onClick={() => handleSelect(searchableModel)}
                            className={cn(
                              'mx-1 mb-1 px-2 py-1.5 rounded-sm cursor-pointer flex items-center gap-2 transition-all duration-200',
                              'hover:bg-secondary/40',
                              isSelected &&
                                'bg-secondary/60 hover:bg-secondary/60'
                            )}
                          >
                            <div className="flex items-center gap-2 flex-1 min-w-0">
                              <span
                                className="text-sm truncate"
                                title={searchableModel.model.id}
                              >
                                {qualifiedModelDisplayName(searchableModel.model)}
                              </span>
                              {searchableModel.model.source && (
                                <ModelSourceBadge
                                  source={searchableModel.model.source}
                                  className="shrink-0"
                                />
                              )}
                              {searchableModel.model.missing && (
                                <MissingModelBadge
                                  source={searchableModel.model.source}
                                  className="shrink-0"
                                />
                              )}
                              <span
                                aria-hidden="true"
                                className={cn(
                                  'ml-auto flex size-3.5 shrink-0 items-center justify-center rounded-full border',
                                  isSelected
                                    ? 'border-blue-500'
                                    : 'border-muted-foreground/40'
                                )}
                                data-testid={`model-selection-${searchableModel.value}`}
                              >
                                {isSelected && (
                                  <span className="size-2 rounded-full bg-blue-500" />
                                )}
                              </span>
                            </div>
                          </div>
                        )
                      })}
                    </div>
                  )
                })}

                {/* Nothing to pick: the list would be a blank panel, so it
                      is the reply gate's — the models recommended for this
                      device, the other ways to get one, and Hugging Face's
                      answer to whatever is typed. Otherwise, under the
                      local matches, Hugging Face's compatible repos for the
                      query — a search with no local hit was a dead end
                      ("No models found") with nothing to download from. */}
                {pickerEmpty ? (
                  <ModelPickerEmptyState
                    query={searchValue}
                    onConnectCloud={() => openCloudDialog()}
                    onConnectSubscription={() =>
                      openCloudDialog(SUBSCRIPTION_PROVIDER)
                    }
                  />
                ) : (
                  searchValue && (
                    <HuggingFacePicks
                      query={searchValue}
                      localEmpty={Object.keys(groupedItems).length === 0}
                    />
                  )
                )}
              </div>
            </div>

          </div>
        )}
      </PopoverContent>

      {/* Beside the panel, not in it (`Popover` renders no element of its
            own): the panel closes as this takes focus, and a dialog inside
            it would go with it. */}
      <AddCloudProviderDialog
        open={cloudDialog.open}
        onOpenChange={(open) => setCloudDialog((prev) => ({ ...prev, open }))}
        onKeySaved={handleCloudConnected}
        initialProviderName={cloudDialog.provider}
        duringOnboarding={false}
      />
    </Popover>
  )
})

export default DropdownModelProvider
