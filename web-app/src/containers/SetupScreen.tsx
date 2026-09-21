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
import { Cloud } from 'lucide-react'
import type { CatalogModel, ModelQuant } from '@/services/models/types'
import { toast } from 'sonner'
import { Button } from '@/components/ui/button'
import { FamilyLogoMark } from '@/containers/ModelLogo'
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
import { parseFileSizeToBytes } from '@/lib/model-card'
import { isProviderConnected } from '@/lib/cloud-providers'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { judgeMemoryFit, type MemoryFit } from '@/lib/hardware-tier'
import { useRecommendedModelsRegistryStore } from '@/stores/recommended-models-registry-store'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelLoad } from '@/hooks/useModelLoad'
import { switchToModel } from '@/utils/switchModel'
import { markSilentImport } from '@/utils/backgroundImports'
import HeaderPage from './HeaderPage'
import SetupBackendStep from './SetupBackendStep'
import { SetupModelRow } from './SetupModelRow'
import { ModelFitIndicator } from './ModelFitIndicator'
import { ConfirmWontFitDownload } from './ConfirmWontFitDownload'
import { useConfirmWontFitDownload } from '@/hooks/useConfirmWontFitDownload'
import {
  describeRecommendationFit,
  fitLabelKey,
  fitLevel,
  interleaveByPublisher,
  orderRowsByFit,
  pickMmprojModel,
  pickPreferredVariant,
  publisherKey,
} from './SetupScreenHelpers'
// The pure pickers and the fit copy live in `SetupScreenHelpers.ts` so the
// reply-model gate can list the same rows; re-exported so their importers
// need no change.
export {
  describeRecommendationFit,
  formatMemoryGb,
  interleaveByPublisher,
  pickMmprojModel,
  pickPreferredVariant,
  publisherKey,
  type RecommendationFitCopy,
} from './SetupScreenHelpers'
import {
  ModelSourceBadge,
  modelSourceLabel,
} from '@/components/ModelSourceBadge'
import { pickSmallestRunnable } from '@/lib/scanned-model-import'
import {
  scanLocalModels,
  collectImportedModelPaths,
  type LocalModelCandidate,
} from '@/services/models/localScan'
import { useModelSources } from '@/hooks/useModelSources'
import { useShallow } from 'zustand/shallow'
import { HuggingFaceAuthorAvatar } from '@/components/HuggingFaceAuthorAvatar'
import { iconKeyLogoSrc, modelFamilyLogoSrc } from '@/lib/model-logo'
import { useStaffPicks } from '@/hooks/useStaffPicks'
import { useStaffPicksStore } from '@/stores/staff-picks-store'
import type { StaffPick } from '@/services/staff-picks-registry'
import { ChatGptMark } from '@/components/icons/chatgpt-mark'
import { RouteRow, ONBOARDING_ROW_ACTION_CLASS } from '@/containers/RouteRow'
import { HUGGINGFACE_LOGO_SRC } from '@/lib/model-logo'
import { prettyModelName } from '@/lib/model-display-name'
import {
  buildRecommendedImpressions,
  captureOnboardingCompleted,
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
import {
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
//* Формат прогресса общий с панелью закачек (ATO-462), чтобы не разъезжался
import { formatProgressPair } from '@/lib/downloadFormat'

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
// first launch feels instant. The rule is shared with the composer widget's
// "add a folder" route, so a folder added there starts the same model this
// screen would have.
export const pickAutoRunCandidate = pickSmallestRunnable

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

/// Neither the on-disk scan nor the hardware enumeration may hold the picker
/// hostage. Both are raced against this deadline; whatever has not answered by
/// then is treated as "nothing found" / `FALLBACK_HARDWARE_TIER`.
const PICKER_INPUT_DEADLINE_MS = 4_000

export function getInitialStep(): OnboardingStep {
  if (typeof window === 'undefined') return 'model'
  // Windows and Linux both install on a CPU build and both have a GPU build
  // to offer; the step used to be Windows-only, so a Linux host met its
  // Vulkan build only if the silent startup upgrade happened to fire.
  if (!IS_WINDOWS && !IS_LINUX) return 'model'
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
    setDownloadOrigin,
    clearDownloadOrigin,
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

  //* Import completion needs both the engine and whether the initiating action
  //* was an explicit Run. A plain Download is tracked for cleanup only and
  //* must never become a selection when its import event lands.
  type LocalLlamacppProvider = 'llamacpp' | 'llamacpp-upstream'
  const trackedImportIdsRef = useRef<
    Map<
      string,
      {
        provider: LocalLlamacppProvider | 'mlx'
        selectOnImport: boolean
      }
    >
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

    void scanLocalModels({
      enabled,
      extraRoots: localScanFolders,
      importedPaths,
    })
      .then((found) => {
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
  // A red row's Download asks first; see ConfirmWontFitDownload.
  const { guardWontFit, confirmation: wontFit } = useConfirmWontFitDownload()
  const recommendedItems = useResolvedRecommendedModels(
    sources,
    hardwareTier,
    hardwareProfile
  )
  // The Hub's curated list, in the Hub's own order. GGUF is the format the
  // Hub opens on and the one every platform runs; the MLX twins stay behind
  // the Hub's format filter, where a user who wants them knows to look.
  const staffPickItems = useStaffPicks(sources, 'gguf')

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

  const autoRunTargetRef = useRef<LocalModelCandidate | null>(null)
  const autoRunTarget = useMemo(
    () => pickAutoRunCandidate(detectedRunnable),
    [detectedRunnable]
  )
  autoRunTargetRef.current = autoRunTarget

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

  // The screen leads with ONE offer. `useResolvedRecommendedModels` returns the
  // ladder rung for this machine first, so the offer is simply the first entry
  // the user does not already have — anything already on disk has moved up into
  // "On your device" with a Run button, which is a better offer than a
  // re-download. The rest of the registry ladder is not rendered: what follows
  // the offer is the Hub's curated list (see `popularPicks`).
  const heroRecommendation = useMemo(() => {
    const lead = pendingRecommended[0]
    if (!lead) return null
    const matchingPick = staffPickItems.find(
      ({ pick }) =>
        pick.model_name.toLowerCase() === lead.rec.modelName.toLowerCase()
    )?.pick
    return matchingPick ? { ...lead, pick: matchingPick } : lead
  }, [pendingRecommended, staffPickItems])

  // The hook types `model` as always present (its `?? null` tail is
  // unreachable for the compiler), but a card can be unresolved at runtime —
  // the rows below say so explicitly.
  type PendingRow = Omit<(typeof pendingRecommended)[number], 'model'> & {
    model: CatalogModel | null
  }

  /**
   * The list under the offer: every one of the Hub's curated picks, in the
   * Hub's order, each with a secondary Download — the same rows Models opens
   * on, so a user who wants something other than the offer does not have to
   * leave onboarding to find it.
   *
   * The offer used to stand alone (d29b99b85): the manifest had served two per
   * tier plus whatever the scanners found, and 6-to-11-row launches read as a
   * comparison table. This is not that list. The offer keeps the badge and the
   * primary button; the picks come in the Hub's own order, plainly secondary,
   * in a box that scrolls so the cloud buttons never move.
   *
   * Only two things are left out, and both are already on screen elsewhere:
   * the offer itself and anything already installed. A pick whose card has
   * not resolved yet keeps its row as a placeholder, as the registry rows
   * always have, so the list is complete from the first paint and fills in.
   * Nothing is hidden for size — the list is the Hub's, not a second
   * recommender.
   *
   * Two liberties are taken with the Hub's order. Rows are listed by how they
   * fit this machine — what fits, then what is tight, then what will not load,
   * then what could not be judged — so a 20 GB model does not head a list on
   * a laptop that can only run the 7 GB one under it (see `orderRowsByFit`).
   * And inside each of those groups rows are dealt so that no two neighbours
   * come from the same publisher (see `interleaveByPublisher`): the manifest
   * groups a family's sizes together, which in a scrolling list reads as five
   * Gemma rows, then five Qwen rows — a catalogue, not a choice.
   */
  const popularPicks = useMemo(() => {
    const taken = new Set<string>()
    if (heroRecommendation) {
      taken.add(heroRecommendation.rec.modelName.toLowerCase())
    }
    for (const { rec } of installedRecommended) {
      taken.add(rec.modelName.toLowerCase())
    }

    const rows: Array<PendingRow & { pick: StaffPick; fit: MemoryFit | null }> =
      []
    for (const { pick, model } of staffPickItems) {
      const key = pick.model_name.toLowerCase()
      if (taken.has(key)) continue
      const isMlx = !!model?.is_mlx
      const variant = model && !isMlx ? pickPreferredVariant(model) : null
      const downloaded = model
        ? isMlx
          ? isMlxDownloaded(model)
          : variant
            ? isVariantDownloaded(model, variant)
            : false
        : false
      if (downloaded) continue
      taken.add(key)
      // Judged on the size the row shows — quant plus projector, or every
      // MLX shard — so the order agrees with the mark the row wears.
      const sizeLabel = model
        ? isMlx
          ? getMlxTotalFileSize(model)
          : variant
            ? getTotalDownloadFileSize(model, variant, pickMmprojModel(model))
            : undefined
        : undefined
      rows.push({
        rec: {
          modelName: pick.model_name,
          descriptionKey: pick.description_key ?? 'hub:recEverydayUse',
        },
        model,
        pick,
        fit: judgeMemoryFit(parseFileSizeToBytes(sizeLabel), hardwareProfile),
        startId: model
          ? isMlx
            ? getMlxModelId(model)
            : variant?.model_id
          : undefined,
      })
    }
    return orderRowsByFit(rows, {
      levelOf: (row) => fitLevel(row.fit),
      keyOf: (row) => publisherKey(row.rec.modelName, row.pick.icon),
      interleave: interleaveByPublisher,
      previous: heroRecommendation
        ? publisherKey(heroRecommendation.rec.modelName)
        : undefined,
    })
  }, [
    staffPickItems,
    heroRecommendation,
    installedRecommended,
    isMlxDownloaded,
    isVariantDownloaded,
    getMlxModelId,
    hardwareProfile,
  ])

  // `recommended_model_shown.position` is the row's index in the painted list:
  // the offer at 0, the picks after it. Clicks report the same index.
  const pickPositionOffset = heroRecommendation ? 1 : 0

  //* P0 онбординг-аналитика: фиксируем показ экрана выбора модели один раз,
  //* дождавшись резолва списка рекомендаций (иначе recommended_count = 0).
  const setupShownFiredRef = useRef(false)
  // State, not only the ref: the impressions effect below has to run once the
  // screen has been reported, whatever its own inputs did in that render.
  const [setupShownReported, setSetupShownReported] = useState(false)
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
      // Reported on every session, found or not: `detected_count` on the
      // autostart event only ever counted the installs where the scan hit.
      detectedLocalModelsCount: detectedRunnable.length,
      detectedSources: [...new Set(detectedRunnable.map((c) => c.source))],
    })
    setSetupShownReported(true)
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

  // Clicks have always carried a `position`; impressions never did, so a row's
  // conversion — and whether the list is read past the first entry — could not
  // be computed at all. Every row the screen paints gets one, once per
  // position: a pick whose card resolves after the first paint is reported
  // when it appears, and since it slots into the Hub's order above rows
  // already reported, those rows are reported again at the index a click on
  // them would now carry. A row nobody saw never gets a denominator.
  //
  // Painted, not merely reported: the auto-start of a model found on disk
  // replaces the picker with a status line (`setup_screen_shown` says so with
  // `rendered: false`), and a row behind a status line was not seen.
  const pickerRendered =
    !pickerInputsPending && !(autoRunTarget && autoRunState !== 'failed')
  const reportedImpressionsRef = useRef(new Set<string>())
  useEffect(() => {
    if (step !== 'model' || !setupShownReported || !pickerRendered) return
    const fresh = buildRecommendedImpressions({
      pending: [
        ...(heroRecommendation ? [heroRecommendation] : []),
        ...popularPicks,
      ],
      installed: installedRecommended,
      detected: detectedRunnable,
    }).filter((item) => {
      const key = `${item.section}:${item.modelId}:${item.position}`
      if (reportedImpressionsRef.current.has(key)) return false
      reportedImpressionsRef.current.add(key)
      return true
    })
    if (fresh.length > 0) captureRecommendedModelsShown(fresh)
  }, [
    step,
    setupShownReported,
    pickerRendered,
    heroRecommendation,
    popularPicks,
    installedRecommended,
    detectedRunnable,
  ])

  const startDownload = useCallback(
    (catalog: CatalogModel, variant: ModelQuant, mmprojPath?: string) => {
      trackedImportIdsRef.current.set(
        variant.model_id,
        {
          provider: LOCAL_LLAMACPP_PROVIDER as LocalLlamacppProvider,
          selectOnImport: false,
        }
      )
      clearResumableDownload(variant.model_id)
      addLocalDownloadingModel(variant.model_id)
      setDownloadOrigin(variant.model_id, catalog.model_name, 'standalone')
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
      setDownloadOrigin,
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

      trackedImportIdsRef.current.set(mlxId, {
        provider: 'mlx',
        selectOnImport: false,
      })
      clearResumableDownload(mlxId)
      addLocalDownloadingModel(mlxId)
      setDownloadOrigin(mlxId, catalog.model_name, 'standalone')

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
        clearDownloadOrigin(mlxId)
        if (
          wasDownloadCancellationRequested(mlxId) ||
          isDownloadCancellationError(error)
        ) {
          return
        }
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
      setDownloadOrigin,
      clearDownloadOrigin,
      serviceHub,
      huggingfaceToken,
      resumableDownloads,
      getMlxModelId,
    ]
  )

  useEffect(() => {
    const handleImportedId = async (
      importedId: string,
      providerName: LocalLlamacppProvider | 'mlx',
      selectOnImport: boolean
    ) => {
      // Download completion is library-only. `DataProvider` refreshes the
      // provider list globally; this screen owns only explicit Run handoffs.
      if (!selectOnImport) {
        trackedImportIdsRef.current.delete(importedId)
        return
      }
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

      const modelId = importedId
      // This branch is reached only for an explicit Run/import action. Passive
      // downloads returned above and are left for a later Send or Run.
      selectModelProvider(providerName, modelId)

      // A model another app left on disk was picked up and started without a
      // screen of its own. Say so once, in the chat the user is about to see,
      // rather than adding a wizard step for it.
      const autoRun = autoRunTargetRef.current
      if (autoRun && autoRun.id === importedId) {
        const source = modelSourceLabel(autoRun.source)
        toast.success(
          source
            ? t('setup:foundFrom', { name: autoRun.displayName, source })
            : t('setup:foundLocal', { name: autoRun.displayName })
        )
      }

      toast.dismiss(`model-validation-started-${modelId}`)
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

      void navigate({
        to: route.home,
        replace: true,
        search: {
          threadModel: { id: modelId, provider: providerName },
        },
      })
    }

    const onModelImported = (payload: { modelId: string }) => {
      const tracked = trackedImportIdsRef.current.get(payload.modelId)
      if (!tracked) return
      void handleImportedId(
        payload.modelId,
        tracked.provider,
        tracked.selectOnImport
      )
    }

    //* MLX не всегда шлёт AppEvent.onModelImported — слушаем прямое событие загрузки
    const onMlxDownloadSuccess = (state: { modelId: string }) => {
      const tracked = trackedImportIdsRef.current.get(state.modelId)
      if (tracked?.provider !== 'mlx') return
      void handleImportedId(
        state.modelId,
        'mlx',
        tracked.selectOnImport
      )
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
  }, [navigate, selectModelProvider, t])

  const enterChatWithModel = useCallback(
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

  // Download is not selection. Complete onboarding and leave the transfer in
  // the global panel, but preserve the current/default model and do not put a
  // `threadModel` in the route for ChatInput to auto-start on arrival.
  const enterChatAfterDownloadStarted = useCallback(() => {
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
    useLeftPanel.getState().setLeftPanel(true)

    void navigate({
      to: route.home,
      replace: true,
      search: {},
    })
  }, [navigate])

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
      trackedImportIdsRef.current.set(cand.id, {
        provider: providerName,
        selectOnImport: true,
      })

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
  // The bottom-right reminder is deliberately NOT armed here: the composer's
  // widget already recommends the same model at the moment of the blocked
  // send, and two surfaces offering one download is nagging, not help.
  const leaveWithoutModel = useCallback(
    (reason: 'dismissed' | 'hub') => {
      if (hasNavigatedRef.current) return
      hasNavigatedRef.current = true

      // Clear the persisted choice before mounting ChatInput, whose effect starts
      // a selected local model. Keep the picker from replacing it with the first
      // installed model when preload is enabled, including after library refresh.
      useModelLoad.getState().deferModelSelection()
      selectModelProvider('', '')

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
      onSkipped?.()

      // Already open for the model step; kept so the main app is never entered
      // with a collapsed sidebar regardless of how this path is reached.
      useLeftPanel.getState().setLeftPanel(true)

      void navigate(
        reason === 'hub'
          ? { to: route.hub.index, replace: true }
          : { to: route.home, replace: true, search: {} }
      )
    },
    [
      navigate,
      onSkipped,
      selectModelProvider,
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
    // Same reasoning for the list under the offer: it is the Hub's manifest,
    // and its store bootstraps from a cache that may predate the change.
    void useStaffPicksStore.getState().refresh({ force: true })
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
   * One downloadable row: the offer, or a Hub pick under it. Same layout for
   * both — mark, name, one line, button — so the list reads as one list.
   *
   * `hero` uses the primary button. Every row shares the same geometry and
   * shows a model summary below its title, memory badge and download size.
   *
   * `index` is the row's position in the painted list, which is what
   * `recommended_model_shown` reports, so clicks and impressions divide.
   */
  const renderPendingRow = (
    item: PendingRow & { pick?: StaffPick },
    index: number,
    hero = false
  ) => {
    const { rec, model, pick } = item
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
    // A curated pick names its mark; a registry row is matched by family.
    const brandIconSrc =
      iconKeyLogoSrc(pick?.icon) ?? recommendedSetupModelIconSrc(rec.modelName)
    const rowDownloadProgress = rowTrackId
      ? downloadProcesses.find((p) => p.id === rowTrackId)
      : undefined

    const startRowDownload = () => {
      if (!model) return
      // Detected-on-disk models still land in the library even when the user
      // downloads a catalog model instead of running them.
      importCandidatesInBackground(localCandidates ?? [])
      if (isMlx) {
        const modelId = getMlxModelId(model)
        captureRecommendedModelClicked({
          modelId,
          format: 'MLX',
          sizeGb: sizeStringToGb(downloadSize),
          position: index,
        })
        void startMlxDownload(model)
        enterChatAfterDownloadStarted()
      } else if (variant) {
        captureRecommendedModelClicked({
          modelId: variant.model_id,
          format: 'GGUF',
          sizeGb: sizeStringToGb(downloadSize),
          position: index,
        })
        startDownload(model, variant, mmproj?.path)
        enterChatAfterDownloadStarted()
      }
    }

    // A red row asks first — see ConfirmWontFitDownload — with the mark's own
    // verdict and sentence, computed below and read at click time. The memory
    // question comes before the disk one pullModelWithMetadata asks on start.
    const onDownload = () =>
      guardWontFit(
        { level: rowFitLevel, name: title, reason: rowFitReason },
        startRowDownload
      )

    // Raster marks (Ornith's, say) arrive as full squares; the corner radius
    // is what keeps them in step with the vector marks around them.
    const icon = brandIconSrc ? (
      <FamilyLogoMark
        src={brandIconSrc}
        className="size-8 shrink-0 rounded-md"
      />
    ) : (
      <HuggingFaceAuthorAvatar
        author={hfAuthor}
        initials={rowInitials}
        className="size-8 shrink-0"
      />
    )

    const title =
      pick?.title ??
      (model
        ? prettyModelName(model.model_name)
        : prettyModelName(rec.modelName))

    const buttonLabel = rowDownloaded ? t('hub:downloaded') : t('hub:download')

    // Progress replaces the subtitle; cancellation lives in the download panel.
    const progressText =
      rowDownloading && rowDownloadProgress && rowDownloadProgress.total > 0
        ? `${Math.round((rowDownloadProgress.progress ?? 0) * 100)}% · ${formatProgressPair(rowDownloadProgress.current, rowDownloadProgress.total)}`
        : null

    const disabled = !model || (!isMlx && !variant) || rowDownloaded

    //* Метка «влезет ли» у каждой строки: тот же размер, что показан рядом с
    //* именем, против бюджета памяти этой машины. Нет размера или профиля —
    //* нет метки: «не знаем» не рисуем как предупреждение.
    const rowSizeBytes = parseFileSizeToBytes(downloadSize ?? undefined)
    const rowFitLevel = fitLevel(judgeMemoryFit(rowSizeBytes, hardwareProfile))
    const rowFitCopy = rowFitLevel
      ? describeRecommendationFit({
          sizeLabel: downloadSize,
          sizeBytes: rowSizeBytes,
          profile: hardwareProfile,
          memoryOnly: true,
        })
      : null
    const rowFitReason = rowFitCopy
      ? t(rowFitCopy.key, {
          ...rowFitCopy.values,
          ...(rowFitCopy.poolKey ? { pool: t(rowFitCopy.poolKey) } : {}),
        })
      : null
    const rowFitTip = rowFitLevel
      ? t(
          `setup:recommend.${{ ok: 'fitTipOk', warn: 'fitTipWarn', no: 'fitTipNo' }[rowFitLevel]}`
        )
      : ''
    const fitMark = rowFitLevel ? (
      <ModelFitIndicator
        level={rowFitLevel}
        label={`${t(fitLabelKey(rowFitLevel))}. ${rowFitTip}`}
        reason={rowFitTip}
      />
    ) : null

    const catalogDescription = model?.description?.trim()
    // Hugging Face's generated catalog description can be only a Markdown
    // dump of repository tags. It is useful for search relevance, but it is
    // not product copy and must never leak into the onboarding row.
    const readableCatalogDescription =
      catalogDescription && !/^\*\*Tags\*\*\s*:/i.test(catalogDescription)
        ? catalogDescription
        : null
    const summary = !model
      ? sourcesLoading
        ? t('hub:loadingModels')
        : t('setup:modelUnavailable')
      : pick?.summary?.trim() || readableCatalogDescription || null

    return (
      <SetupModelRow
        key={`${rec.modelName}-${rec.descriptionKey}`}
        icon={icon}
        title={title}
        fitMark={fitMark}
        hero={hero}
        downloadSize={downloadSize}
        progressText={progressText}
        summary={summary}
        rowDownloading={rowDownloading}
        disabled={disabled}
        onDownload={onDownload}
        buttonLabel={buttonLabel}
      />
    )
  }

  /**
   * A cloud route, laid out as a model row — mark, name, one line, button —
   * so the card reads as a second list rather than a pair of links. The
   * button shows only the verb; its accessible name is the whole action,
   * since "Add" alone says nothing to a screen reader.
   */
  const renderCloudRow = ({
    icon,
    title,
    hint,
    action,
    label,
    onClick,
    testId,
  }: {
    icon: React.ReactNode
    title: string
    hint: string
    action: string
    label: string
    onClick: () => void
    testId?: string
  }) => (
    <RouteRow
      layout="onboarding"
      icon={icon}
      title={title}
      hint={hint}
      action={action}
      label={label}
      onClick={onClick}
      data-testid={testId}
    />
  )

  return (
    <div className="relative flex h-full w-full flex-col overflow-hidden">
      <div className="flex h-full min-h-0 w-full flex-col">
        <HeaderPage />

        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto">
          {/* Wide enough for a row to hold a name, its fit badge and a
              compact Download button on one line; narrow enough for the
              1024 px minimum window beside the sidebar. */}
          <div className="pointer-events-auto mx-auto my-auto flex w-full max-w-[640px] flex-col px-6 py-8 sm:py-10">
            {/* No logo over the title: the sidebar already wears the lockup a
                hand's width away, and two of them read as a splash screen. */}
            <div className="mb-6 flex shrink-0 flex-col items-center text-center">
              <h1 className="text-3xl font-semibold leading-tight tracking-tight">
                {t('setup:welcomeTitle')}
              </h1>
            </div>

            <div className="relative z-10 flex flex-col gap-4">
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
                                <FamilyLogoMark
                                  src={brandIconSrc}
                                  className="size-8 shrink-0 rounded-md"
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
                                className={ONBOARDING_ROW_ACTION_CLASS}
                              >
                                {isImporting
                                  ? t('setup:localStep.running')
                                  : t('setup:localStep.run')}
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
                                  <FamilyLogoMark
                                    src={brandIconSrc}
                                    className="size-8 shrink-0 rounded-md"
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
                                    enterChatWithModel(startId, provider)
                                  }}
                                  className={ONBOARDING_ROW_ACTION_CLASS}
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
                {/* The offer — the rung of the ladder this machine sits on,
                    see `useResolvedRecommendedModels` — with the Hub's picks
                    under it in a box that scrolls, so the buttons below stay
                    put however long the list is. */}
                {(heroRecommendation || popularPicks.length > 0) && (
                  <div className="flex flex-col gap-2">
                    <span className="shrink-0 text-left text-xs font-medium text-muted-foreground">
                      {t('setup:recommend.title')}
                    </span>
                    <div
                      className={cn(
                        'w-full shrink-0 rounded-lg border bg-secondary/50 px-3 py-2',
                        'max-h-[min(50vh,26rem)] overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]'
                      )}
                    >
                      <div className="flex flex-col divide-y divide-border/60">
                        {heroRecommendation &&
                          renderPendingRow(heroRecommendation, 0, true)}
                        {popularPicks.map((item, index) =>
                          renderPendingRow(item, index + pickPositionOffset)
                        )}
                      </div>
                    </div>
                  </div>
                )}

                {/* Peers of the model list: a card of the same weight, with
                    rows laid out like its rows. Connecting a cloud provider
                    during onboarding is the single strongest activation signal
                    we have, and it had happened on seven devices in the
                    product's history while it lived as small print under the
                    list. The "or" now heads an equal card, not a footnote. */}
                <div className="relative z-60 flex shrink-0 flex-col gap-2">
                  <span className="shrink-0 text-left text-xs font-medium text-muted-foreground">
                    {t('setup:cloudStep.sectionTitle')}
                  </span>
                  {/* The list's box, gutter included, so these buttons land
                      in the same column as the Download buttons above. */}
                  <div className="w-full shrink-0 overflow-hidden rounded-lg border bg-secondary/50 px-3 py-2 [scrollbar-gutter:stable]">
                    <div className="flex flex-col divide-y divide-border/60">
                      {/* The rest of Hugging Face lives in Models. Offered
                          here so a user who wants something other than the
                          picks does not have to find the Hub by themselves. */}
                      {renderCloudRow({
                        icon: <img src={HUGGINGFACE_LOGO_SRC} alt="" />,
                        title: t('setup:cloudStep.huggingFaceTitle'),
                        hint: t(
                          IS_MACOS
                            ? 'setup:cloudStep.huggingFaceHint'
                            : 'setup:cloudStep.huggingFaceHintGguf'
                        ),
                        action: t('setup:cloudStep.browse'),
                        label: t('setup:cloudStep.huggingFaceTrigger'),
                        onClick: () => leaveWithoutModel('hub'),
                        testId: 'setup-browse-hub',
                      })}
                      {subscriptionProvider &&
                        renderCloudRow({
                          icon: <ChatGptMark />,
                          title: t('setup:cloudStep.subscriptionTitle'),
                          hint: t('setup:cloudStep.subscriptionHint'),
                          action: t('setup:cloudStep.connect'),
                          label: t('setup:cloudStep.subscriptionTrigger'),
                          onClick: openSubscription,
                        })}
                      {hasCloudProviders &&
                        renderCloudRow({
                          icon: <Cloud />,
                          title: t('setup:cloudStep.providerTitle'),
                          hint: t('setup:cloudStep.providerHint'),
                          action: t('setup:cloudStep.addApiKey'),
                          label: t('setup:cloudStep.trigger'),
                          onClick: openCloudGallery,
                        })}
                    </div>
                  </div>
                </div>

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

      <ConfirmWontFitDownload {...wontFit} />
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
