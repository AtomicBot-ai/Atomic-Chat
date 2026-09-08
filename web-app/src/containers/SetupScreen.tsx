import { useModelProvider } from '@/hooks/useModelProvider'
import { useNavigate } from '@tanstack/react-router'
import { route } from '@/constants/routes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { localStorageKey } from '@/constants/localStorage'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useEffect, useMemo, useCallback, useRef, useState } from 'react'
import { AppEvent, DownloadEvent, EngineManager, events } from '@janhq/core'
import { ChevronDown, Cloud } from 'lucide-react'
import type {
  CatalogModel,
  MMProjModel,
  ModelQuant,
} from '@/services/models/types'
import { DEFAULT_MODEL_QUANTIZATIONS } from '@/constants/models'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { cn, sanitizeModelId, LOCAL_LLAMACPP_PROVIDER } from '@/lib/utils'
import {
  extractModelName,
  getMlxTotalFileSize,
  getPreferredMmprojModel,
  getTotalDownloadFileSize,
} from '@/lib/models'
import { useResolvedRecommendedModels } from '@/hooks/useResolvedRecommendedModels'
import { useHardwareTier } from '@/hooks/useHardwareTier'
import {
  AddCloudProviderDialog,
  selectCloudGalleryProviders,
  type CloudProviderSaveResult,
} from '@/containers/dialogs/AddCloudProviderDialog'
import { findPinnedQuant, parseFileSizeToBytes } from '@/lib/model-card'
import ProvidersAvatar from '@/containers/ProvidersAvatar'
import { isProviderConnected } from '@/lib/cloud-providers'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { judgeMemoryFit, type HardwareProfile } from '@/lib/hardware-tier'
import { useRecommendedModelsRegistryStore } from '@/stores/recommended-models-registry-store'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelLoad } from '@/hooks/useModelLoad'
import { useOnboardingModelReminderStore } from '@/hooks/useOnboardingModelReminder'
import { switchToModel } from '@/utils/switchModel'
import { markSilentImport } from '@/utils/backgroundImports'
import HeaderPage from './HeaderPage'
import SetupBackendStep from './SetupBackendStep'
import { ModelSourceBadge } from '@/components/ModelSourceBadge'
import {
  scanLocalModels,
  collectImportedModelPaths,
  type LocalModelCandidate,
} from '@/services/models/localScan'
import { useModelSources } from '@/hooks/useModelSources'
import { useShallow } from 'zustand/shallow'
import { HuggingFaceAuthorAvatar } from '@/components/HuggingFaceAuthorAvatar'
import { modelFamilyLogoSrc } from '@/lib/model-logo'
import { prettyModelName } from '@/lib/model-display-name'
import {
  buildRecommendedImpressions,
  captureOnboardingCompleted,
  captureOtherOptionsOpened,
  captureRecommendedModelClicked,
  captureRecommendedModelsShown,
  captureSetupLocalModelAutostarted,
  captureSetupLocalModelRun,
  captureSetupScreenShown,
  captureSetupSkipped,
  markOnboardingInFlight,
  type OnboardingStep,
} from '@/lib/onboarding-telemetry'
import { describeProviderState } from '@/lib/onboarding'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
//* Формат прогресса общий с панелью закачек (ATO-462), чтобы не разъезжался
import { formatProgressPair } from '@/lib/downloadFormat'

//* Вариант загрузки: пин из манифеста, иначе приоритет квантов как в Hub.
//! Пин обязателен для LFM2.5-VL-450M (нужен Q8_0): репозиторий отдаёт и Q4_K_M,
//! который матчится DEFAULT_MODEL_QUANTIZATIONS — без пина скачается рабочий,
//! но не тот файл, и ошибка не всплывёт нигде.
export function pickPreferredVariant(
  model: CatalogModel,
  quantPin?: string
): ModelQuant | null {
  const pinned = findPinnedQuant(model.quants, quantPin)
  if (pinned) return pinned
  const preferred =
    model.quants?.find((m) =>
      DEFAULT_MODEL_QUANTIZATIONS.some((e) =>
        m.model_id.toLowerCase().includes(e)
      )
    ) ?? null
  return preferred ?? model.quants?.[0] ?? null
}

//* Проектор для vision-моделей: пин из манифеста, иначе обычный выбор.
//! getPreferredMmprojModel ищет буквальный id 'mmproj-f16'. У LiquidAI id —
//! 'mmproj-LFM2_5-VL-450m-F16', совпадения нет, и он падает на mmproj_models[0]
//! = BF16 (181 MB) вместо Q8_0 (98 MB).
export function pickMmprojModel(
  model: CatalogModel,
  quantPin?: string
): MMProjModel | undefined {
  return (
    findPinnedQuant(model.mmproj_models, quantPin) ??
    getPreferredMmprojModel(model)
  )
}

//* Размер найденной на диске модели (байты → "4.50 GB" / "850 MB")
export function formatDetectedSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

//* Числовой размер в ГБ из строки каталога ("4.5 GB" / "850 MB") для аналитики.
export function sizeStringToGb(size?: string): number | undefined {
  if (!size) return undefined

  const match = size.trim().match(/^([\d.]+)\s*(MB|GB)$/i)
  if (!match) return undefined

  const value = Number(match[1])
  if (!Number.isFinite(value)) return undefined

  const gb = match[2].toUpperCase() === 'GB' ? value : value / 1024
  return Math.round(gb * 100) / 100
}

//* Иконка бренда по id репозитория HF (см. modelFamilyLogoSrc)
const recommendedSetupModelIconSrc = modelFamilyLogoSrc

// Auto-start picks the smallest runnable candidate: it loads fastest, so the
// first launch feels instant. Candidates without a known size sort last, so a
// measured model always wins over an unmeasured one.
export function pickAutoRunCandidate(
  cands: LocalModelCandidate[]
): LocalModelCandidate | null {
  let best: LocalModelCandidate | null = null
  for (const cand of cands) {
    if (!cand.runnable) continue
    if (!best) {
      best = cand
      continue
    }
    const size = cand.sizeBytes ?? Number.POSITIVE_INFINITY
    const bestSize = best.sizeBytes ?? Number.POSITIVE_INFINITY
    if (size < bestSize) best = cand
  }
  return best
}

type SetupScreenProps = {
  onSkipped?: () => void
}

/// Onboarding step machine.
///   - 'backend' — Windows-only first step that detects the GPU and offers
///     to download the optimal llama.cpp backend. Skipped on macOS/Linux
///     and on Windows after the user has been through it once
///     (`localStorageKey.llamacppOnboardingDone` is set).
///   - 'model' — model selection screen. Models already on disk (detected by
///     the local scanner — LM Studio / HF cache / Unsloth / Ollama) are listed
///     at the top with a "Run" button (one-click import, no re-download); the
///     recommended catalog models follow below with a "Download" button.

/// The subscription this screen offers by name, beside the API-key gallery.
/// Signing in is not "a cloud provider whose key happens to be a login" — it is
/// the shortest exit from onboarding there is, so it gets its own button.
const SUBSCRIPTION_PROVIDER = 'chatgpt'

/// A download click used to swap the screen out instantly, which read as "did
/// my click register?" — the row flipping to a progress readout was gone before
/// it could be seen. The picker now holds for this long so the started download
/// is visible, then hands over to the chat where the sidebar continues it.
const DOWNLOAD_ENTER_DELAY_MS = 3_000

/// Neither the on-disk scan nor the hardware enumeration may hold the picker
/// hostage. Both are raced against this deadline; whatever has not answered by
/// then is treated as "nothing found" / `FALLBACK_HARDWARE_TIER`.
const PICKER_INPUT_DEADLINE_MS = 4_000

/// Whole-GB rendering of a MiB figure, for the "why this one" line. Rounded to
/// what the user would call their machine ("16 GB"), not to a decimal place
/// nobody reads off a spec sheet.
export function formatMemoryGb(mib?: number): string | null {
  if (!mib || mib <= 0) return null
  return `${Math.round(mib / 1024)} GB`
}

/**
 * The one line under the recommendation that says why it is this model.
 *
 * Returns the i18n key and its interpolation values rather than a string, so
 * the component stays a single `t()` call and the wording lives in the locale
 * files with the rest.
 *
 * The tiers deliberately say different things: a machine with no accelerator is
 * not memory-bound at all — it is bound by CPU throughput, and telling its owner
 * "fits your 64 GB" would explain the wrong constraint. Everything else is
 * judged by {@link judgeMemoryFit}, whose macOS ceiling is a hard one.
 */
export type RecommendationFitCopy = {
  key: string
  values: Record<string, string>
  /**
   * Name of the memory pool, as its own key so the caller resolves it before
   * interpolating. "16 GB" on a Mac and "16 GB" on a graphics card are not the
   * same 16 GB, and a line that omits which one reads as a claim about RAM.
   */
  poolKey?: string
}

export function describeRecommendationFit(args: {
  sizeLabel?: string | null
  sizeBytes?: number
  profile: HardwareProfile | null
}): RecommendationFitCopy | null {
  const { sizeLabel, sizeBytes, profile } = args
  if (!sizeLabel) return null
  const values: Record<string, string> = { size: sizeLabel }

  if (profile?.memoryKind === 'system') {
    return { key: 'setup:recommend.whyCpuOnly', values }
  }

  const budget = formatMemoryGb(profile?.budgetMib)
  const fit = judgeMemoryFit(sizeBytes, profile)
  if (!budget || !fit || !profile) {
    return { key: 'setup:recommend.whyUnknown', values }
  }

  const key = {
    comfortable: 'setup:recommend.whyComfortable',
    tight: 'setup:recommend.whyTight',
    spills: 'setup:recommend.whySpills',
    wont_load: 'setup:recommend.whyWontLoad',
  }[fit]
  return {
    key,
    values: { ...values, budget },
    poolKey: `setup:recommend.pool.${profile.memoryKind}`,
  }
}

export function getInitialStep(): OnboardingStep {
  if (typeof window === 'undefined') return 'model'
  if (!IS_WINDOWS) return 'model'
  // Already completed the dedicated step in a previous session.
  if (localStorage.getItem(localStorageKey.llamacppOnboardingDone)) {
    return 'model'
  }
  return 'backend'
}

function SetupScreen({ onSkipped }: SetupScreenProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const { providers, getProviderByName, selectModelProvider, setProviders } =
    useModelProvider()

  const [step, setStep] = useState<OnboardingStep>(getInitialStep)
  // Read at exit rather than derived from `step`, so an exit that races a step
  // transition still reports the screen the user was actually on.
  const stepReachedRef = useRef<OnboardingStep>(step)
  stepReachedRef.current = step

  const handleBackendStepDone = useCallback(
    (status: 'downloaded' | 'skipped') => {
      try {
        localStorage.setItem(localStorageKey.llamacppOnboardingDone, status)
      } catch (err) {
        console.warn(
          '[SetupScreen] failed to persist llamacpp onboarding flag',
          err
        )
      }
      setStep('model')
    },
    []
  )

  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
    addLocalDownloadingModel,
    removeLocalDownloadingModel,
    markResumableDownload,
    clearResumableDownload,
  } = useDownloadStore()
  const serviceHub = useServiceHub()
  // Use the platform-active llama.cpp provider id. Windows only exposes
  // `llamacpp-upstream` after the upstream-only consolidation; macOS/Linux
  // still default to the turboquant `llamacpp` provider.
  const llamaProvider = getProviderByName(LOCAL_LLAMACPP_PROVIDER)
  const mlxProvider = getProviderByName('mlx')
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)

  const {
    sources,
    fetchSources,
    loading: sourcesLoading,
  } = useModelSources(
    useShallow((state) => ({
      sources: state.sources,
      fetchSources: state.fetchSources,
      loading: state.loading,
    }))
  )

  //* id → провайдер, чтобы после import-события знать, куда навигировать.
  //* На Windows у нас только `llamacpp-upstream`; на macOS/Linux — `llamacpp`.
  type LocalLlamacppProvider = 'llamacpp' | 'llamacpp-upstream'
  const trackedImportIdsRef = useRef<
    Map<string, LocalLlamacppProvider | 'mlx'>
  >(new Map())
  const hasNavigatedRef = useRef(false)
  // Wall clock for `onboarding_completed.duration_ms` — how long the user spent
  // in the flow before whichever exit they took.
  const onboardingStartedAtRef = useRef(Date.now())
  // Imported only after the chosen model is handled (see handleImportedId), so
  // their fast imports can't flip the route before a large pick finishes.
  const pendingBackgroundImportsRef = useRef<LocalModelCandidate[]>([])
  const importCandidatesInBackgroundRef = useRef<
    (cands: LocalModelCandidate[]) => void
  >(() => {})

  // Local-model detection: null = still scanning, [] = nothing found. We never
  // block onboarding on a slow scan (4s safety timeout below).
  const [localCandidates, setLocalCandidates] = useState<
    LocalModelCandidate[] | null
  >(null)
  const [importingLocalId, setImportingLocalId] = useState<string | null>(null)

  // The tier decides which single model the screen leads with, so rendering
  // before it is known would swap the offer under the user. Hardware
  // enumeration starts at app boot and is normally done well before onboarding
  // paints, so this deadline is a backstop, not a routine wait.
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  // Which entry point opened the dialog: the gallery of API keys, or the named
  // subscription button, which has to land on the sign-in rather than send the
  // user back to a gallery to find it again.
  const [cloudEntry, setCloudEntry] = useState<'gallery' | 'subscription'>(
    'gallery'
  )
  const openCloudGallery = useCallback(() => {
    setCloudEntry('gallery')
    setCloudDialogOpen(true)
  }, [])
  const openSubscription = useCallback(() => {
    setCloudEntry('subscription')
    setCloudDialogOpen(true)
  }, [])

  // Опции сверх основной рекомендации: скрыты, пока их не попросят.
  const [otherOptionsOpen, setOtherOptionsOpen] = useState(false)
  // Показы этих строк уходят один раз за экран — на первом раскрытии.
  const otherOptionsShownRef = useRef(false)

  const [tierDeadlineElapsed, setTierDeadlineElapsed] = useState(false)
  useEffect(() => {
    const timer = setTimeout(
      () => setTierDeadlineElapsed(true),
      PICKER_INPUT_DEADLINE_MS
    )
    return () => clearTimeout(timer)
  }, [])

  // A model already on disk from another app means onboarding never has to
  // offer a download: it launches that model straight away. 'failed' falls back
  // to the manual picker, and the ref keeps a failed launch from retrying.
  const [autoRunState, setAutoRunState] = useState<
    'idle' | 'running' | 'failed'
  >('idle')
  const autoRunFiredRef = useRef(false)

  // Set while the picker holds on screen showing a just-started download (see
  // DOWNLOAD_ENTER_DELAY_MS). The timer is kept so unmounting can cancel it.
  const [downloadStartedId, setDownloadStartedId] = useState<string | null>(
    null
  )
  const enterChatTimerRef = useRef<ReturnType<typeof setTimeout> | null>(null)
  useEffect(
    () => () => {
      if (enterChatTimerRef.current) clearTimeout(enterChatTimerRef.current)
    },
    []
  )

  useEffect(() => {
    fetchSources()
  }, [fetchSources])

  // Onboarding owns model launching for the duration of the setup screen, so
  // DataProvider must stand down from auto-launching the background bulk-imports
  // (see DataProvider.handleModelImported). Error toasts are NOT muted here —
  // every onboarding load is dispatched with `isAutoStart`, which already keeps
  // failed auto-starts silent. We still clear any stale toast on entry.
  useEffect(() => {
    useModelLoad.getState().setOnboardingActive(true)
    toast.dismiss('model-load-error')
    return () => {
      useModelLoad.getState().setOnboardingActive(false)
    }
  }, [])

  // Scan once for models from other apps (honors Settings toggle/folders + dedup).
  useEffect(() => {
    let cancelled = false
    const timer = setTimeout(() => {
      if (!cancelled) setLocalCandidates((prev) => prev ?? [])
    }, PICKER_INPUT_DEADLINE_MS)

    const { scanLocalModels: enabled, localScanFolders } =
      useGeneralSetting.getState()
    const importedPaths = collectImportedModelPaths(
      useModelProvider.getState().providers
    )

    // TEMP debug: see exactly what the onboarding scan returns + dedup inputs.
    console.debug('[SetupScreen] local scan start', {
      enabled,
      localScanFolders,
      importedPaths,
    })

    void scanLocalModels({
      enabled,
      extraRoots: localScanFolders,
      importedPaths,
    })
      .then((found) => {
        console.debug('[SetupScreen] local scan result', {
          total: found.length,
          runnable: found.filter((c) => c.runnable).length,
          candidates: found.map((c) => ({
            id: c.id,
            source: c.source,
            runnable: c.runnable,
            path: c.path,
          })),
        })
        if (!cancelled) setLocalCandidates(found)
      })
      .catch((err) => {
        console.debug('[SetupScreen] local scan failed', err)
        if (!cancelled) setLocalCandidates([])
      })
    return () => {
      cancelled = true
      clearTimeout(timer)
    }
  }, [])

  const {
    tier: hardwareTier,
    profile: hardwareProfile,
    ready: hardwareTierReady,
  } = useHardwareTier()
  const recommendedItems = useResolvedRecommendedModels(sources, hardwareTier)

  // Every input the picker needs before it can paint a stable list.
  const pickerInputsPending =
    localCandidates === null || (!hardwareTierReady && !tierDeadlineElapsed)

  // Detected-on-disk models shown at the top of the picker. Only runnable
  // candidates get a Run button (LoRA adapters need a base model first, so
  // they're omitted from onboarding).
  const detectedRunnable = useMemo(
    () => (localCandidates ?? []).filter((c) => c.runnable),
    [localCandidates]
  )

  const autoRunTarget = useMemo(
    () => pickAutoRunCandidate(detectedRunnable),
    [detectedRunnable]
  )

  // A window close gives the renderer nothing to hang an exit event on, so the
  // run is recorded here and reported as abandoned at the next launch if it is
  // still there. Re-runs on step change so `step_reached` is the real one.
  useEffect(() => {
    markOnboardingInFlight(step, onboardingStartedAtRef.current)
  }, [step])

  const downloadProcesses = useMemo(
    () =>
      Object.values(downloads).map((download) => ({
        id: download.name,
        name: download.name,
        progress: download.progress,
        current: download.current,
        total: download.total,
      })),
    [downloads]
  )

  const isVariantDownloading = useCallback(
    (variantId: string) =>
      localDownloadingModels.has(variantId) ||
      downloadProcesses.some((e) => e.id === variantId),
    [localDownloadingModels, downloadProcesses]
  )

  const isVariantDownloaded = useCallback(
    (catalog: CatalogModel, variant: ModelQuant) =>
      llamaProvider?.models.some(
        (m: { id: string }) =>
          m.id === variant.model_id ||
          m.id === `${catalog.developer}/${sanitizeModelId(variant.model_id)}`
      ) ?? false,
    [llamaProvider]
  )

  //* MLX: id в реестре провайдера. ВАЖНО: MLX-движок использует свой sanitizer
  //* (сохраняет точки, пробелы → '-'), отличный от @/lib/utils.sanitizeModelId
  //* (который бы схлопнул '.' → '_'). Дублируем логику MlxModelDownloadAction.
  const getMlxModelId = useCallback((catalog: CatalogModel) => {
    const raw = catalog.model_name.split('/').pop() ?? catalog.model_name
    return raw.replace(/\s+/g, '-').replace(/[^a-zA-Z0-9\-_./]/g, '')
  }, [])

  const isMlxDownloaded = useCallback(
    (catalog: CatalogModel) => {
      const mlxId = getMlxModelId(catalog)
      return (
        mlxProvider?.models.some(
          (m: { id: string }) =>
            m.id === mlxId || m.id === `${catalog.developer}/${mlxId}`
        ) ?? false
      )
    },
    [mlxProvider, getMlxModelId]
  )

  //* Уже установленные рекомендованные модели переезжают в секцию «На вашем
  //* устройстве» с живой кнопкой запуска; остальные остаются в рекомендациях.
  const { installedRecommended, pendingRecommended } = useMemo(() => {
    const installed: Array<{
      rec: (typeof recommendedItems)[number]['rec']
      model: CatalogModel
      startId: string
      provider: LocalLlamacppProvider | 'mlx'
      sizeLabel: string | null | undefined
    }> = []
    const pending: Array<
      (typeof recommendedItems)[number] & { startId?: string }
    > = []

    for (const item of recommendedItems) {
      const { model } = item
      if (!model) {
        pending.push(item)
        continue
      }
      const isMlx = !!model.is_mlx
      const variant = !isMlx
        ? pickPreferredVariant(model, item.rec.quant)
        : null
      const downloaded = isMlx
        ? isMlxDownloaded(model)
        : variant
          ? isVariantDownloaded(model, variant)
          : false

      if (downloaded) {
        installed.push({
          rec: item.rec,
          model,
          startId: isMlx ? getMlxModelId(model) : variant!.model_id,
          provider: (isMlx ? 'mlx' : LOCAL_LLAMACPP_PROVIDER) as
            | LocalLlamacppProvider
            | 'mlx',
          sizeLabel: isMlx
            ? getMlxTotalFileSize(model)
            : getTotalDownloadFileSize(
                model,
                variant!,
                pickMmprojModel(model, item.rec.mmprojQuant)
              ),
        })
      } else {
        // The id a click on this row would attribute to, resolved here so the
        // impression event can name the same model the click will.
        pending.push({
          ...item,
          startId: isMlx ? getMlxModelId(model) : variant?.model_id,
        })
      }
    }

    return { installedRecommended: installed, pendingRecommended: pending }
  }, [recommendedItems, isMlxDownloaded, isVariantDownloaded, getMlxModelId])

  // The screen leads with ONE model. `useResolvedRecommendedModels` returns the
  // ladder rung for this machine first, so the hero is simply the first entry
  // the user does not already have — anything already on disk has moved up into
  // "On your device" with a Run button, which is a better offer than a
  // re-download. Everything else waits behind "other options".
  //
  // Why one and not the previous list of two-to-eleven: the manifest served two
  // per tier plus whatever the scanners found, and historical launches shipped
  // 6, 10 and 11 rows. A first screen whose job is "start chatting" should not
  // open with a comparison table.
  const heroRecommendation = pendingRecommended[0] ?? null
  const otherRecommendations = useMemo(
    () => pendingRecommended.slice(1),
    [pendingRecommended]
  )

  //* P0 онбординг-аналитика: фиксируем показ экрана выбора модели один раз,
  //* дождавшись резолва списка рекомендаций (иначе recommended_count = 0).
  const setupShownFiredRef = useRef(false)
  useEffect(() => {
    if (step !== 'model' || setupShownFiredRef.current) return
    if (pickerInputsPending) return
    // A pending auto-start means the picker is never rendered. It used to
    // suppress the event entirely, which dropped those sessions out of the
    // funnel; now it is reported with `rendered: false`.
    const rendered = !(autoRunTarget && autoRunState !== 'failed')
    if (rendered && recommendedItems.length === 0 && sourcesLoading) return
    setupShownFiredRef.current = true
    captureSetupScreenShown({
      recommendedCount: recommendedItems.length,
      rendered,
      hardwareTier,
      hardwareTierResolved: hardwareTierReady,
      memoryKind: hardwareProfile?.memoryKind ?? null,
      memoryBudgetMib: hardwareProfile?.budgetMib ?? null,
      primaryModelId: heroRecommendation?.startId ?? null,
    })
    // Clicks have always carried a `position`; impressions never did, so a
    // row's conversion — and whether the list is read past the first entry —
    // could not be computed at all.
    captureRecommendedModelsShown(
      buildRecommendedImpressions({
        // Only the offer: the rest sit behind the disclosure and are reported
        // when it is opened, so a row nobody saw never gets a denominator.
        pending: heroRecommendation ? [heroRecommendation] : [],
        installed: installedRecommended,
        detected: detectedRunnable,
      })
    )
  }, [
    step,
    pickerInputsPending,
    autoRunTarget,
    autoRunState,
    recommendedItems.length,
    sourcesLoading,
    hardwareTier,
    hardwareTierReady,
    hardwareProfile,
    heroRecommendation,
    installedRecommended,
    detectedRunnable,
  ])

  const startDownload = useCallback(
    (catalog: CatalogModel, variant: ModelQuant, mmprojPath?: string) => {
      trackedImportIdsRef.current.set(
        variant.model_id,
        LOCAL_LLAMACPP_PROVIDER as LocalLlamacppProvider
      )
      clearResumableDownload(variant.model_id)
      addLocalDownloadingModel(variant.model_id)
      serviceHub
        .models()
        .pullModelWithMetadata(
          variant.model_id,
          variant.path,
          mmprojPath ?? getPreferredMmprojModel(catalog)?.path,
          huggingfaceToken,
          true,
          resumableDownloads.has(variant.model_id)
        )
    },
    [
      addLocalDownloadingModel,
      clearResumableDownload,
      serviceHub,
      huggingfaceToken,
      resumableDownloads,
    ]
  )

  //* MLX-скачивание (полная репликация логики MlxModelDownloadAction)
  const startMlxDownload = useCallback(
    async (catalog: CatalogModel) => {
      const mlxId = getMlxModelId(catalog)
      const modelPath = `${catalog.developer}/${catalog.model_name.split('/').pop()}`

      trackedImportIdsRef.current.set(mlxId, 'mlx')
      clearResumableDownload(mlxId)
      addLocalDownloadingModel(mlxId)

      try {
        const repoInfo = await serviceHub
          .models()
          .fetchHuggingFaceRepo(modelPath, huggingfaceToken)

        if (!repoInfo?.siblings?.length) {
          throw new Error('Failed to fetch repository files')
        }

        const modelFiles = repoInfo.siblings
        const mainSafetensorsFile = modelFiles.find((f) =>
          f.rfilename.toLowerCase().endsWith('.safetensors')
        )
        if (!mainSafetensorsFile) {
          throw new Error('No safetensors file found in repository')
        }

        const engine = EngineManager.instance().get('mlx')
        if (!engine) throw new Error('MLX engine not found')

        const modelUrl = `https://huggingface.co/${modelPath}/resolve/main/${mainSafetensorsFile.rfilename}`
        const extraFiles = modelFiles
          .filter((f) => f.rfilename !== mainSafetensorsFile.rfilename)
          .map((file) => ({
            url: `https://huggingface.co/${modelPath}/resolve/main/${file.rfilename}`,
            filename: file.rfilename,
          }))

        return engine.import(mlxId, {
          modelPath: modelUrl,
          files: extraFiles,
          resume: resumableDownloads.has(mlxId),
        })
      } catch (error) {
        console.error('Error downloading MLX model:', error)
        trackedImportIdsRef.current.delete(mlxId)
        markResumableDownload(mlxId)
        removeLocalDownloadingModel(mlxId)
        toast.error('Failed to download MLX model', {
          description: extractModelErrorMessage(error),
        })
      }
    },
    [
      addLocalDownloadingModel,
      removeLocalDownloadingModel,
      markResumableDownload,
      clearResumableDownload,
      serviceHub,
      huggingfaceToken,
      resumableDownloads,
      getMlxModelId,
    ]
  )

  useEffect(() => {
    const handleImportedId = async (
      importedId: string,
      providerName: LocalLlamacppProvider | 'mlx'
    ) => {
      if (hasNavigatedRef.current) return
      hasNavigatedRef.current = true
      captureOnboardingCompleted({
        exitPath: 'imported',
        hadAnyModel: true,
        providerState: describeProviderState(
          useModelProvider.getState().providers
        ),
        stepReached: stepReachedRef.current,
        startedAtMs: onboardingStartedAtRef.current,
      })
      trackedImportIdsRef.current.delete(importedId)

      const providers = await serviceHub.providers().getProviders()
      setProviders(providers)

      const catalogId = importedId
      const backslashId = catalogId.replace(/\//g, '\\')

      // Select up-front so the dropdown "first local" fallback can't override it.
      const prov = providers.find((p) => p.provider === providerName)
      const found = prov?.models.find(
        (m) => m.id === catalogId || m.id === backslashId
      )
      const modelId = found ? found.id : catalogId
      selectModelProvider(providerName, modelId)

      toast.dismiss(`model-validation-started-${catalogId}`)
      localStorage.setItem(localStorageKey.setupCompleted, 'true')

      // Lets the root layout mount the global BackendUpdater now onboarding is done.
      window.dispatchEvent(new Event('app:setup-completed'))
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider: providerName, model: modelId })
      )

      // Idempotent for the model step, which already opened it; still needed
      // for the collapsed Windows backend step.
      useLeftPanel.getState().setLeftPanel(true)

      // Add the rest only now, so they can't flip the route before this pick.
      const rest = pendingBackgroundImportsRef.current
      pendingBackgroundImportsRef.current = []
      if (rest.length) importCandidatesInBackgroundRef.current(rest)

      // Explicit user pick (not an auto-start) so a load error surfaces on the
      // model they clicked. Fire-and-forget so nav isn't blocked on weights.
      void switchToModel({
        modelId,
        providerName,
        serviceHub,
      }).catch(() => {})

      navigate({
        to: route.home,
        replace: true,
        search: {
          threadModel: { id: modelId, provider: providerName },
        },
      })
    }

    const onModelImported = (payload: { modelId: string }) => {
      const provider = trackedImportIdsRef.current.get(payload.modelId)
      if (!provider) return
      void handleImportedId(payload.modelId, provider)
    }

    //* MLX не всегда шлёт AppEvent.onModelImported — слушаем прямое событие загрузки
    const onMlxDownloadSuccess = (state: { modelId: string }) => {
      const provider = trackedImportIdsRef.current.get(state.modelId)
      if (provider !== 'mlx') return
      void handleImportedId(state.modelId, 'mlx')
    }

    events.on(AppEvent.onModelImported, onModelImported)
    events.on(
      DownloadEvent.onFileDownloadAndVerificationSuccess,
      onMlxDownloadSuccess
    )

    return () => {
      events.off(AppEvent.onModelImported, onModelImported)
      events.off(
        DownloadEvent.onFileDownloadAndVerificationSuccess,
        onMlxDownloadSuccess
      )
    }
  }, [navigate, selectModelProvider, serviceHub, setProviders])

  const enterChatForDownload = useCallback(
    (modelId: string, providerName: LocalLlamacppProvider | 'mlx') => {
      if (hasNavigatedRef.current) return

      hasNavigatedRef.current = true
      captureOnboardingCompleted({
        exitPath: 'download_started',
        hadAnyModel: true,
        providerState: describeProviderState(
          useModelProvider.getState().providers
        ),
        stepReached: stepReachedRef.current,
        startedAtMs: onboardingStartedAtRef.current,
      })
      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      window.dispatchEvent(new Event('app:setup-completed'))
      localStorage.setItem(
        localStorageKey.lastUsedModel,
        JSON.stringify({ provider: providerName, model: modelId })
      )

      useLeftPanel.getState().setLeftPanel(true)

      void navigate({
        to: route.home,
        replace: true,
        search: {
          threadModel: { id: modelId, provider: providerName },
        },
      })
    },
    [navigate]
  )

  // Download path: unlike "Run", which switches to a model that is ready, this
  // one leaves the user waiting on bytes — so the row is held on screen long
  // enough to show that the download actually started before the chat (and its
  // sidebar progress) takes over.
  const enterChatAfterDownloadStart = useCallback(
    (modelId: string, providerName: LocalLlamacppProvider | 'mlx') => {
      if (hasNavigatedRef.current || enterChatTimerRef.current) return
      setDownloadStartedId(modelId)
      enterChatTimerRef.current = setTimeout(() => {
        enterChatTimerRef.current = null
        enterChatForDownload(modelId, providerName)
      }, DOWNLOAD_ENTER_DELAY_MS)
    },
    [enterChatForDownload]
  )

  // Provider that runs a given candidate (MLX vs the upstream llama.cpp engine).
  const providerForCandidate = useCallback(
    (cand: LocalModelCandidate): LocalLlamacppProvider | 'mlx' =>
      cand.format === 'mlx'
        ? 'mlx'
        : (LOCAL_LLAMACPP_PROVIDER as LocalLlamacppProvider),
    []
  )

  // Fire-and-forget library imports (no launch/navigation). Once all settle,
  // refresh the library so they appear even if this screen has moved on.
  const importCandidatesInBackground = useCallback(
    (cands: LocalModelCandidate[]) => {
      const runnable = cands.filter((c) => c.runnable)
      if (runnable.length === 0) return
      const imports = runnable.map((c) => {
        const eng = EngineManager.instance().get(providerForCandidate(c))
        if (!eng) return Promise.resolve()
        // Mark silent so DataProvider's import handler never auto-launches it.
        markSilentImport(c.id)
        return eng
          .import(c.id, {
            modelPath: c.path,
            mmprojPath: c.mmprojPath,
            source: c.source,
          })
          .catch(() => {})
      })
      void Promise.allSettled(imports).then(async () => {
        try {
          const refreshed = await serviceHub.providers().getProviders()
          setProviders(refreshed)
        } catch {
          // best-effort: a later provider refresh will surface them
        }
      })
    },
    [providerForCandidate, serviceHub, setProviders]
  )

  // Keeps the ref current for the earlier onModelImported effect.
  useEffect(() => {
    importCandidatesInBackgroundRef.current = importCandidatesInBackground
  }, [importCandidatesInBackground])

  // Import the picked model (no download) and launch it; the rest are imported
  // in the background so every detected model lands in the library.
  // Resolves false when the model could not be imported, which lets the
  // auto-start path fall back to the picker instead of hanging on a launch
  // that will never navigate.
  const onRunLocalModel = useCallback(
    async (cand: LocalModelCandidate): Promise<boolean> => {
      if (!cand.runnable || importingLocalId) return false
      const providerName = providerForCandidate(cand)
      const engine = EngineManager.instance().get(providerName)
      if (!engine) {
        toast.error(t('setup:localStep.importFailed'), {
          description: `Engine ${providerName} not available`,
        })
        return false
      }

      setImportingLocalId(cand.id)
      // Only the chosen model is tracked, so only it triggers navigation.
      trackedImportIdsRef.current.set(cand.id, providerName)

      // Deferred until the chosen model is handled (see handleImportedId).
      pendingBackgroundImportsRef.current = (localCandidates ?? []).filter(
        (c) => c.id !== cand.id
      )

      try {
        await engine.import(cand.id, {
          modelPath: cand.path,
          mmprojPath: cand.mmprojPath,
          source: cand.source,
        })
        return true
      } catch (error) {
        trackedImportIdsRef.current.delete(cand.id)
        setImportingLocalId(null)
        // Chosen model failed, so add the rest here (handleImportedId won't).
        const rest = pendingBackgroundImportsRef.current
        pendingBackgroundImportsRef.current = []
        if (rest.length) importCandidatesInBackground(rest)
        toast.error(t('setup:localStep.importFailed'), {
          description: extractModelErrorMessage(error),
        })
        return false
      }
    },
    [
      importingLocalId,
      importCandidatesInBackground,
      localCandidates,
      providerForCandidate,
      t,
    ]
  )

  // Onboarding never offers a download when another app already left a model on
  // disk: the smallest one is imported and launched immediately, and the picker
  // is only rendered if that fails.
  useEffect(() => {
    if (step !== 'model' || localCandidates === null) return
    if (!autoRunTarget || autoRunFiredRef.current) return

    autoRunFiredRef.current = true
    setAutoRunState('running')
    captureSetupLocalModelAutostarted({
      scanSource: autoRunTarget.source,
      format: autoRunTarget.format,
      sizeBytes: autoRunTarget.sizeBytes,
      detectedCount: detectedRunnable.length,
    })

    void onRunLocalModel(autoRunTarget).then((started) => {
      if (!started) setAutoRunState('failed')
    })
  }, [
    step,
    localCandidates,
    autoRunTarget,
    detectedRunnable.length,
    onRunLocalModel,
  ])

  // Exit taken when the user connects a cloud provider instead of downloading
  // a model. Deliberately does NOT arm the bottom-right model reminder: that
  // nudge is for users who left empty-handed, and a configured key is a
  // finished setup, not an abandoned one.
  const enterChatWithCloudProvider = useCallback(
    ({ providerName, modelId }: CloudProviderSaveResult) => {
      if (hasNavigatedRef.current) return
      hasNavigatedRef.current = true

      captureOnboardingCompleted({
        exitPath: 'cloud_provider',
        hadAnyModel: true,
        providerState: describeProviderState(
          useModelProvider.getState().providers
        ),
        // Without this a ChatGPT subscription and a pasted API key are the
        // same exit.
        exitProvider: providerName,
        stepReached: stepReachedRef.current,
        startedAtMs: onboardingStartedAtRef.current,
      })

      // Same courtesy as every other exit: models found on disk still land in
      // the library even though the user chose a cloud provider.
      importCandidatesInBackground(localCandidates ?? [])

      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      window.dispatchEvent(new Event('app:setup-completed'))

      if (modelId) {
        // Select up-front so the dropdown's "first local" fallback cannot
        // override the provider the user just configured.
        selectModelProvider(providerName, modelId)
        localStorage.setItem(
          localStorageKey.lastUsedModel,
          JSON.stringify({ provider: providerName, model: modelId })
        )
      } else {
        localStorage.removeItem(localStorageKey.lastUsedModel)
      }

      useLeftPanel.getState().setLeftPanel(true)

      if (modelId) {
        // Registers the remote provider and starts the local proxy.
        // Fire-and-forget so navigation is not blocked on it.
        void switchToModel({ modelId, providerName, serviceHub }).catch(
          () => {}
        )
      }

      void navigate({
        to: route.home,
        replace: true,
        search: modelId
          ? { threadModel: { id: modelId, provider: providerName } }
          : {},
      })
    },
    [
      navigate,
      selectModelProvider,
      serviceHub,
      importCandidatesInBackground,
      localCandidates,
    ]
  )

  // Providers worth offering in the cloud dialog. Hidden rather than disabled
  // when empty, so onboarding never opens a dialog with nothing in it.
  const hasCloudProviders = useMemo(
    () => selectCloudGalleryProviders(providers).length > 0,
    [providers]
  )

  // The ChatGPT subscription, promoted out of the key gallery into a button of
  // its own. It is not a key you paste, it is a sign-in — and connecting *any*
  // cloud provider during onboarding is close to a guaranteed activation (144
  // of 153 who did it activated; day-2 return 58.3 % against 36.7 %), while
  // `provider_key_configured.during_onboarding = true` has fired for seven
  // devices in the product's history. That gap is the whole reason these two
  // buttons now sit beside the model rather than under an "or".
  //
  // Kept as the provider object, not a boolean: the button wears the
  // subscription's own mark so the named route is recognisable at a glance.
  const subscriptionProvider = useMemo(() => {
    if (!PlatformFeatures[PlatformFeature.CHATGPT_SUBSCRIPTION])
      return undefined
    const provider = providers.find((p) => p.provider === SUBSCRIPTION_PROVIDER)
    return provider && !isProviderConnected(provider) ? provider : undefined
  }, [providers])

  // Leaving onboarding empty-handed, by pressing Skip.
  //
  // This used to be a 15-second timer with no visible control: 60 % of all
  // onboarding exits took it, at a 16.2 s median — people were sitting through
  // it, not being rescued by it. The reason it had no button was that leaving
  // without a model was a dead end; ATO-453's composer widget removed the dead
  // end, so the honest control can exist.
  //
  // Picking a model takes a different route (handleImportedId /
  // enterChatForDownload) and must not arm the bottom-right reminder.
  const leaveWithoutModel = useCallback(
    (reason: 'dismissed') => {
      if (hasNavigatedRef.current) return
      hasNavigatedRef.current = true

      // Still import every detected model (no launch) before leaving onboarding.
      importCandidatesInBackground(localCandidates ?? [])
      // Legacy predicate, kept verbatim so `had_any_model` stays comparable
      // with its own history. It means "the picker had something to show" —
      // `providerState` below is what actually answers "did they leave with a
      // model", and the two disagreeing is itself worth seeing.
      const hadAnyModel = providers.some(
        (p) => (p.models?.length ?? 0) > 0 || !!p.api_key
      )
      captureSetupSkipped({ hadAnyModel, reason })
      captureOnboardingCompleted({
        exitPath: reason,
        hadAnyModel,
        providerState: describeProviderState(providers),
        stepReached: stepReachedRef.current,
        startedAtMs: onboardingStartedAtRef.current,
      })
      localStorage.setItem(localStorageKey.setupCompleted, 'true')
      // Same-tab signal — see useSetupCompleted in routes/__root.tsx.
      window.dispatchEvent(new Event('app:setup-completed'))
      localStorage.removeItem(localStorageKey.lastUsedModel)
      useOnboardingModelReminderStore.getState().setPending(true)
      onSkipped?.()

      // Already open for the model step; kept so the main app is never entered
      // with a collapsed sidebar regardless of how this path is reached.
      useLeftPanel.getState().setLeftPanel(true)

      void navigate({
        to: route.home,
        replace: true,
        search: {},
      })
    },
    [
      navigate,
      onSkipped,
      providers,
      importCandidatesInBackground,
      localCandidates,
    ]
  )

  // Unlike the previous full-screen onboarding, the model step lives inside the
  // chat area, so the sidebar is already there when the user lands in chat.
  useEffect(() => {
    if (step !== 'model') return
    useLeftPanel.getState().setLeftPanel(true)
  }, [step])

  // The registry's one-hour cache is served without touching the network, which
  // is fine everywhere except here: onboarding is the one screen whose whole
  // content is the recommendation list, and showing a list the manifest no
  // longer contains is worse than a 5s fetch. Fires once per mount; the store
  // keeps the previous list meanwhile and falls back on its own if the fetch
  // fails, so there is nothing to await and nothing to unwind.
  const forcedRegistryRefreshRef = useRef(false)
  useEffect(() => {
    if (step !== 'model' || forcedRegistryRefreshRef.current) return
    forcedRegistryRefreshRef.current = true
    void useRecommendedModelsRegistryStore.getState().refresh({ force: true })
  }, [step])

  // Windows: dedicated llama.cpp backend step runs first. Once the user
  // either downloads or skips it the flag is persisted so subsequent
  // launches skip straight to model selection.
  if (step === 'backend') {
    return <SetupBackendStep onDone={handleBackendStepDone} />
  }

  // Two states that replace the picker entirely: the brief scan (so detected
  // models don't pop in and shove the list down) and the auto-start of a model
  // found on disk, which needs feedback rather than a decision.
  const statusMessage = pickerInputsPending
    ? t('common:loading')
    : autoRunState === 'running' && autoRunTarget
      ? t('setup:localStep.autoStarting', {
          name: prettyModelName(autoRunTarget.displayName),
        })
      : null

  if (statusMessage) {
    return (
      <div className="relative flex h-full w-full flex-col overflow-hidden">
        <HeaderPage />
        <div className="flex flex-1 items-center justify-center">
          <div className="text-muted-foreground text-sm">{statusMessage}</div>
        </div>
      </div>
    )
  }

  /**
   * One downloadable recommendation.
   *
   * The same markup serves the hero and the "other options" rows — a second
   * copy for the hero would be a second place for the download wiring, the
   * MLX/GGUF split and the progress readout to drift apart. `hero` changes only
   * the emphasis: a card instead of a list row, the "why this one" line, and a
   * full-width primary button.
   *
   * `index` is the row's position in `pendingRecommended`, which is what
   * `recommended_model_shown` reports, so clicks and impressions divide.
   */
  const renderPendingRow = (
    item: (typeof pendingRecommended)[number],
    index: number,
    hero = false
  ) => {
    const { rec, model } = item
    const isMlx = !!model?.is_mlx
    const variant =
      model && !isMlx ? pickPreferredVariant(model, rec.quant) : null
    //* Тот же проектор, что уйдёт в загрузку, — иначе строка покажет размер
    //* одного файла, а скачается другой.
    const mmproj =
      model && !isMlx ? pickMmprojModel(model, rec.mmprojQuant) : undefined
    //* MLX: суммируем все safetensors-шарды; GGUF: quant + mmproj
    const downloadSize = isMlx
      ? getMlxTotalFileSize(model!)
      : model && variant
        ? getTotalDownloadFileSize(model, variant, mmproj)
        : variant?.file_size
    //* id, по которому опрашиваем downloadStore (GGUF → quant.id, MLX → mlxId)
    const rowTrackId = isMlx
      ? model
        ? getMlxModelId(model)
        : null
      : (variant?.model_id ?? null)
    const rowDownloading = rowTrackId ? isVariantDownloading(rowTrackId) : false
    const rowDownloaded = isMlx
      ? model
        ? isMlxDownloaded(model)
        : false
      : model && variant
        ? isVariantDownloaded(model, variant)
        : false
    const hfAuthor =
      model?.developer?.trim() || rec.modelName.split('/')[0]?.trim() || ''
    const nameForInitials =
      extractModelName(rec.modelName) || rec.modelName || '?'
    const rowInitials =
      nameForInitials
        .replace(/\.(gguf|GGUF)$/i, '')
        .replace(/[^a-zA-Z0-9]/g, '')
        .slice(0, 2) ||
      hfAuthor.slice(0, 2) ||
      '?'
    const brandIconSrc = recommendedSetupModelIconSrc(rec.modelName)
    const rowDownloadProgress = rowTrackId
      ? downloadProcesses.find((p) => p.id === rowTrackId)
      : undefined

    const onDownload = () => {
      if (!model) return
      // Detected-on-disk models still land in the library even when the user
      // downloads a catalog model instead of running them.
      importCandidatesInBackground(localCandidates ?? [])
      if (isMlx) {
        captureRecommendedModelClicked({
          modelId: getMlxModelId(model),
          format: 'MLX',
          sizeGb: sizeStringToGb(downloadSize),
          position: index,
        })
        void startMlxDownload(model)
        enterChatAfterDownloadStart(getMlxModelId(model), 'mlx')
      } else if (variant) {
        captureRecommendedModelClicked({
          modelId: variant.model_id,
          format: 'GGUF',
          sizeGb: sizeStringToGb(downloadSize),
          position: index,
        })
        startDownload(model, variant, mmproj?.path)
        enterChatAfterDownloadStart(
          variant.model_id,
          LOCAL_LLAMACPP_PROVIDER as LocalLlamacppProvider
        )
      }
    }

    const icon = brandIconSrc ? (
      <img
        src={brandIconSrc}
        alt=""
        className={cn('shrink-0 object-contain', hero ? 'size-10' : 'size-8')}
        draggable={false}
        aria-hidden
      />
    ) : (
      <HuggingFaceAuthorAvatar
        author={hfAuthor}
        initials={rowInitials}
        className={cn('shrink-0', hero ? 'size-10' : 'size-8')}
      />
    )

    const title = model
      ? prettyModelName(model.model_name)
      : prettyModelName(rec.modelName)

    const buttonLabel = rowDownloaded
      ? t('hub:downloaded')
      : rowDownloading
        ? t('setup:downloading')
        : t('hub:download')

    const progressLine =
      rowDownloading && rowTrackId ? (
        <p
          className={cn(
            'text-xs text-muted-foreground tabular-nums',
            hero ? 'text-center' : 'text-right'
          )}
          aria-live="polite"
        >
          {rowDownloadProgress && rowDownloadProgress.total > 0
            ? `${Math.round((rowDownloadProgress.progress ?? 0) * 100)}% · ${formatProgressPair(rowDownloadProgress.current, rowDownloadProgress.total)}`
            : t('setup:downloadPreparing')}
        </p>
      ) : null

    // Says where the download is about to go, so the screen change three
    // seconds later is something the user was told about.
    const handoffLine =
      rowTrackId && downloadStartedId === rowTrackId ? (
        <p
          className={cn(
            'text-xs text-muted-foreground',
            hero ? 'text-center' : 'text-right'
          )}
        >
          {t('setup:downloadStartedOpening')}
        </p>
      ) : null

    const disabled =
      !model || (!isMlx && !variant) || rowDownloading || rowDownloaded

    if (hero) {
      //* «Почему эта»: размер против бюджета памяти этой машины, а не
      //* абстрактное «рекомендуем» — см. describeRecommendationFit.
      const fit = describeRecommendationFit({
        sizeLabel: downloadSize,
        sizeBytes: parseFileSizeToBytes(downloadSize ?? undefined),
        profile: hardwareProfile,
      })

      return (
        <div
          key={`${rec.modelName}-${rec.descriptionKey}`}
          className="flex w-full shrink-0 flex-col gap-3 rounded-lg border bg-secondary/50 p-4"
        >
          <div className="flex min-w-0 items-center gap-3">
            {icon}
            <div className="min-w-0 flex-1">
              <h2 className="truncate text-sm font-medium leading-tight">
                {title}
              </h2>
              <p className="mt-0.5 text-xs leading-snug text-muted-foreground">
                {fit
                  ? t(fit.key, {
                      ...fit.values,
                      ...(fit.poolKey ? { pool: t(fit.poolKey) } : {}),
                    })
                  : !model && sourcesLoading
                    ? t('hub:loadingModels')
                    : !model
                      ? t('setup:modelUnavailable')
                      : t(rec.descriptionKey)}
              </p>
            </div>
          </div>
          <Button
            size="sm"
            disabled={disabled}
            onClick={onDownload}
            className="w-full rounded-full"
          >
            {buttonLabel}
          </Button>
          {progressLine}
          {handoffLine}
        </div>
      )
    }

    return (
      <div
        key={`${rec.modelName}-${rec.descriptionKey}`}
        className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
      >
        <div className="flex min-w-0 flex-1 items-center gap-3">
          {icon}
          <div className="min-w-0 flex-1">
            <h2 className="truncate text-sm font-medium leading-tight">
              {title}
              {downloadSize ? (
                <span className="text-xs font-normal text-muted-foreground">
                  {' '}
                  · {downloadSize}
                </span>
              ) : null}
            </h2>
            {!model && (
              <p className="mt-1 text-xs text-muted-foreground">
                {sourcesLoading
                  ? t('hub:loadingModels')
                  : t('setup:modelUnavailable')}
              </p>
            )}
          </div>
        </div>
        <div className="flex shrink-0 flex-col items-end gap-1">
          <Button
            size="sm"
            disabled={disabled}
            onClick={onDownload}
            className="shrink-0 rounded-full px-4"
          >
            {/* Reserve width for the widest possible label so the button
                doesn't reflow when its state flips between Download /
                Downloading… / Downloaded. */}
            <span className="grid">
              <span
                aria-hidden="true"
                className="invisible col-start-1 row-start-1"
              >
                {t('setup:downloading')}
              </span>
              <span
                aria-hidden="true"
                className="invisible col-start-1 row-start-1"
              >
                {t('hub:downloaded')}
              </span>
              <span
                aria-hidden="true"
                className="invisible col-start-1 row-start-1"
              >
                {t('hub:download')}
              </span>
              <span className="col-start-1 row-start-1">{buttonLabel}</span>
            </span>
          </Button>
          {progressLine}
          {handoffLine}
        </div>
      </div>
    )
  }

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="flex h-full min-h-0 w-full flex-col">
        <HeaderPage />

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          <div className="pointer-events-auto mx-auto my-auto flex w-full max-w-[520px] flex-col px-6 py-8 sm:py-10">
            <div className="mb-5 flex shrink-0 flex-col items-center gap-3 text-center">
              <div className="flex size-9 shrink-0 items-center justify-center rounded-lg bg-neutral-950 p-1 shadow-sm dark:bg-white dark:shadow-none">
                <img
                  src="/images/transparent-logo.png"
                  alt=""
                  className="size-full min-h-0 min-w-0 object-contain invert dark:invert-0"
                  draggable={false}
                />
              </div>
              <div>
                <h1 className="text-xl font-semibold leading-snug tracking-tight">
                  {t('setup:welcomeTitle')}
                </h1>
                <p className="text-muted-foreground mt-1 text-sm">
                  {t('setup:welcomeSubtitle')}
                </p>
              </div>
            </div>

            <div className="relative z-50 flex flex-col gap-4">
              {(detectedRunnable.length > 0 ||
                installedRecommended.length > 0) && (
                <div className="flex flex-col gap-2">
                  <span className="shrink-0 text-left text-xs font-medium text-muted-foreground">
                    {t('setup:localStep.onDeviceTitle')}
                  </span>
                  <div
                    className={cn(
                      'w-full shrink-0 rounded-lg border bg-secondary/50 px-3 py-2',
                      'max-h-[min(40vh,22rem)] overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]'
                    )}
                  >
                    <div className="flex flex-col divide-y divide-border/60">
                      {detectedRunnable.map((cand) => {
                        const brandIconSrc = recommendedSetupModelIconSrc(
                          cand.displayName
                        )
                        const rowInitials =
                          cand.displayName
                            .replace(/\.(gguf|GGUF)$/i, '')
                            .replace(/[^a-zA-Z0-9]/g, '')
                            .slice(0, 2) || '?'
                        const size = formatDetectedSize(cand.sizeBytes)
                        const isImporting = importingLocalId === cand.id

                        return (
                          <div
                            key={cand.id}
                            className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                          >
                            <div className="flex min-w-0 flex-1 items-center gap-3">
                              {brandIconSrc ? (
                                <img
                                  src={brandIconSrc}
                                  alt=""
                                  className="size-8 shrink-0 object-contain"
                                  draggable={false}
                                  aria-hidden
                                />
                              ) : (
                                <HuggingFaceAuthorAvatar
                                  author=""
                                  initials={rowInitials}
                                  className="size-8 shrink-0"
                                />
                              )}
                              <div className="min-w-0 flex-1">
                                <h2
                                  className="truncate text-sm font-medium leading-tight"
                                  title={cand.path}
                                >
                                  {prettyModelName(cand.displayName)}
                                  {size ? (
                                    <span className="text-xs font-normal text-muted-foreground">
                                      {' '}
                                      · {size}
                                    </span>
                                  ) : null}
                                </h2>
                                <div className="mt-1 flex flex-wrap items-center gap-x-2.5 gap-y-1 text-xs text-muted-foreground">
                                  <ModelSourceBadge source={cand.source} />
                                </div>
                              </div>
                            </div>
                            <div className="flex shrink-0 flex-col items-end gap-1">
                              <Button
                                size="sm"
                                disabled={importingLocalId !== null}
                                onClick={() => {
                                  captureSetupLocalModelRun({
                                    trigger: 'manual',
                                    scanSource: cand.source,
                                    format: cand.format,
                                    sizeBytes: cand.sizeBytes,
                                    detectedCount: detectedRunnable.length,
                                  })
                                  void onRunLocalModel(cand)
                                }}
                                className="shrink-0 rounded-full px-4"
                              >
                                <span className="grid">
                                  <span
                                    aria-hidden="true"
                                    className="invisible col-start-1 row-start-1"
                                  >
                                    {t('setup:localStep.running')}
                                  </span>
                                  <span className="col-start-1 row-start-1">
                                    {isImporting
                                      ? t('setup:localStep.running')
                                      : t('setup:localStep.run')}
                                  </span>
                                </span>
                              </Button>
                            </div>
                          </div>
                        )
                      })}
                      {installedRecommended.map(
                        ({ rec, model, startId, provider, sizeLabel }) => {
                          const brandIconSrc = recommendedSetupModelIconSrc(
                            rec.modelName
                          )
                          const hfAuthor =
                            model.developer?.trim() ||
                            rec.modelName.split('/')[0]?.trim() ||
                            ''
                          const rowInitials =
                            (extractModelName(rec.modelName) || rec.modelName)
                              .replace(/\.(gguf|GGUF)$/i, '')
                              .replace(/[^a-zA-Z0-9]/g, '')
                              .slice(0, 2) ||
                            hfAuthor.slice(0, 2) ||
                            '?'

                          return (
                            <div
                              key={`installed-${rec.modelName}-${rec.descriptionKey}`}
                              className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
                            >
                              <div className="flex min-w-0 flex-1 items-center gap-3">
                                {brandIconSrc ? (
                                  <img
                                    src={brandIconSrc}
                                    alt=""
                                    className="size-8 shrink-0 object-contain"
                                    draggable={false}
                                    aria-hidden
                                  />
                                ) : (
                                  <HuggingFaceAuthorAvatar
                                    author={hfAuthor}
                                    initials={rowInitials}
                                    className="size-8 shrink-0"
                                  />
                                )}
                                <div className="min-w-0 flex-1">
                                  <h2 className="truncate text-sm font-medium leading-tight">
                                    {prettyModelName(model.model_name)}
                                    {sizeLabel ? (
                                      <span className="text-xs font-normal text-muted-foreground">
                                        {' '}
                                        · {sizeLabel}
                                      </span>
                                    ) : null}
                                  </h2>
                                </div>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                <Button
                                  size="sm"
                                  disabled={importingLocalId !== null}
                                  onClick={() => {
                                    captureSetupLocalModelRun({
                                      trigger: 'installed_recommended',
                                      providerId: provider,
                                      format: model.is_mlx ? 'mlx' : 'gguf',
                                    })
                                    importCandidatesInBackground(
                                      localCandidates ?? []
                                    )
                                    enterChatForDownload(startId, provider)
                                  }}
                                  className="shrink-0 rounded-full px-4"
                                >
                                  {t('setup:localStep.run')}
                                </Button>
                              </div>
                            </div>
                          )
                        }
                      )}
                    </div>
                  </div>
                </div>
              )}

              <div className="flex flex-col gap-3">
                {/* One offer, not a list. The rung of the ladder this machine
                    sits on — see `useResolvedRecommendedModels`. */}
                {heroRecommendation && (
                  <>
                    <span className="shrink-0 text-left text-xs font-medium text-muted-foreground">
                      {t('setup:recommend.title')}
                    </span>
                    {renderPendingRow(heroRecommendation, 0, true)}
                  </>
                )}

                {/* Everything heavier, lighter or simply different. Collapsed
                    by default: the screen's job is to get one model running,
                    and the comparison is what the Hub is for. */}
                {otherRecommendations.length > 0 && (
                  <div className="flex flex-col gap-2">
                    <button
                      type="button"
                      aria-expanded={otherOptionsOpen}
                      onClick={() => {
                        // Only the opening is worth an event: how often one
                        // offer is not enough is the measurement that says
                        // whether leading with one model was the right trade.
                        if (!otherOptionsOpen) {
                          captureOtherOptionsOpened({
                            hardwareTier,
                            optionCount: otherRecommendations.length,
                          })
                          // These rows become visible now, not at paint. Fired
                          // once per screen even if the user toggles the
                          // disclosure again — an impression is a row being
                          // seen, not a row being re-rendered.
                          if (!otherOptionsShownRef.current) {
                            otherOptionsShownRef.current = true
                            captureRecommendedModelsShown(
                              buildRecommendedImpressions({
                                pending: otherRecommendations,
                                // Row 0 is the offer, reported at paint.
                                pendingOffset: 1,
                              })
                            )
                          }
                        }
                        setOtherOptionsOpen((open) => !open)
                      }}
                      className="flex shrink-0 items-center justify-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground"
                    >
                      {otherOptionsOpen
                        ? t('setup:recommend.hideOtherOptions')
                        : t('setup:recommend.otherOptions', {
                            count: otherRecommendations.length,
                          })}
                      <ChevronDown
                        aria-hidden
                        className={cn(
                          'size-3.5 transition-transform',
                          otherOptionsOpen && 'rotate-180'
                        )}
                      />
                    </button>
                    {otherOptionsOpen && (
                      <div
                        className={cn(
                          'w-full shrink-0 rounded-lg border bg-secondary/50 px-3 py-2',
                          'max-h-[min(40vh,22rem)] overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]'
                        )}
                      >
                        <div className="flex flex-col divide-y divide-border/60">
                          {otherRecommendations.map((item, index) =>
                            renderPendingRow(item, index + 1)
                          )}
                        </div>
                      </div>
                    )}
                  </div>
                )}

                {/* Peers of the model, not a footnote under an "or".
                    Connecting a cloud provider during onboarding is the single
                    strongest activation signal we have, and it had happened on
                    seven devices in the product's history because it lived
                    below a divider that framed it as the consolation prize. */}
                {(hasCloudProviders || subscriptionProvider) && (
                  <div className="relative z-60 flex shrink-0 flex-col gap-2 pt-1 sm:flex-row">
                    {hasCloudProviders && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={openCloudGallery}
                        className="relative z-60 flex-1 rounded-full px-4"
                      >
                        <Cloud />
                        {t('setup:cloudStep.trigger')}
                      </Button>
                    )}
                    {subscriptionProvider && (
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={openSubscription}
                        className="relative z-60 flex-1 rounded-full px-4"
                      >
                        {/* Decorative: the label already names the route, and
                            the avatar's own alt text would otherwise be read as
                            part of the button's name. */}
                        <span aria-hidden className="flex">
                          <ProvidersAvatar
                            provider={subscriptionProvider}
                            className="size-4 shrink-0"
                          />
                        </span>
                        {t('setup:cloudStep.subscriptionTrigger')}
                      </Button>
                    )}
                  </div>
                )}

                {/* The honest way out, replacing a 15-second timer that took
                    60 % of all onboarding exits without ever showing itself.
                    Safe to offer now that the composer asks the question again
                    at the moment it matters (ATO-453). */}
                <div className="flex shrink-0 justify-center pt-1">
                  <Button
                    type="button"
                    variant="link"
                    size="sm"
                    onClick={() => leaveWithoutModel('dismissed')}
                    className="text-muted-foreground hover:text-foreground h-auto py-1 text-xs hover:no-underline"
                  >
                    {t('setup:skip')}
                  </Button>
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AddCloudProviderDialog
        open={cloudDialogOpen}
        onOpenChange={setCloudDialogOpen}
        onKeySaved={enterChatWithCloudProvider}
        // The subscription button must land on the sign-in, not on a gallery
        // the user then has to find it in again.
        initialProviderName={
          cloudEntry === 'subscription' ? SUBSCRIPTION_PROVIDER : undefined
        }
      />
    </div>
  )
}

export default SetupScreen
