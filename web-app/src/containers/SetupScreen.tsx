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
import { findPinnedQuant } from '@/lib/model-card'
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
import { RecommendedModelChip } from '@/components/RecommendedModelChip'
import { chipVariantForRecommendedDescriptionKey } from '@/constants/recommendedModelChip'
import { modelFamilyLogoSrc } from '@/lib/model-logo'
import posthog from 'posthog-js'
import { getAnalyticsPlatform } from '@/lib/telemetry'
import {
  captureOnboardingCompleted,
  captureSetupLocalModelRun,
  captureSetupScreenShown,
} from '@/lib/onboarding-telemetry'

//* Вариант загрузки: пин из манифеста, иначе приоритет квантов как в Hub.
//! Пин обязателен для LFM2.5-VL-450M (нужен Q8_0): репозиторий отдаёт и Q4_K_M,
//! который матчится DEFAULT_MODEL_QUANTIZATIONS — без пина скачается рабочий,
//! но не тот файл, и ошибка не всплывёт нигде.
function pickPreferredVariant(
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
function pickMmprojModel(
  model: CatalogModel,
  quantPin?: string
): MMProjModel | undefined {
  return findPinnedQuant(model.mmproj_models, quantPin) ?? getPreferredMmprojModel(model)
}

//* ГБ для строки прогресса (как в DownloadManagement)
function formatDownloadGb(bytes: number): string {
  return (bytes / 1024 ** 3).toFixed(2)
}

//* Размер найденной на диске модели (байты → "4.50 GB" / "850 MB")
function formatDetectedSize(bytes?: number): string | null {
  if (!bytes || bytes <= 0) return null
  const gb = bytes / 1024 ** 3
  if (gb >= 1) return `${gb.toFixed(2)} GB`
  return `${Math.max(1, Math.round(bytes / 1024 ** 2))} MB`
}

//* Числовой размер в ГБ из строки каталога ("4.5 GB" / "850 MB") для аналитики.
function sizeStringToGb(size?: string): number | undefined {
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
function pickAutoRunCandidate(
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
type OnboardingStep = 'backend' | 'model'

/// Onboarding must never trap the user behind a multi-gigabyte decision: if the
/// model step is left untouched for this long we enter the chat anyway and hand
/// the recommendation over to the bottom-right reminder.
const MODEL_STEP_AUTO_EXIT_MS = 15_000

/// Neither the on-disk scan nor the hardware enumeration may hold the picker
/// hostage. Both are raced against this deadline; whatever has not answered by
/// then is treated as "nothing found" / "assume a standard machine".
const PICKER_INPUT_DEADLINE_MS = 4_000

function getInitialStep(): OnboardingStep {
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

  // The tier decides which two models the picker advertises, so rendering
  // before it is known would swap the whole list under the user. Hardware
  // enumeration starts at app boot and is normally done well before onboarding
  // paints, so this deadline is a backstop, not a routine wait.
  // Open state is mirrored into a ref because the auto-exit timeout callback
  // below closes over its own render's value.
  const [cloudDialogOpen, setCloudDialogOpen] = useState(false)
  const cloudDialogOpenRef = useRef(false)
  const setCloudDialog = useCallback((open: boolean) => {
    cloudDialogOpenRef.current = open
    setCloudDialogOpen(open)
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

  const { tier: hardwareTier, ready: hardwareTierReady } = useHardwareTier()
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
    })
  }, [
    step,
    pickerInputsPending,
    autoRunTarget,
    autoRunState,
    recommendedItems.length,
    sourcesLoading,
    hardwareTier,
    hardwareTierReady,
  ])

  //* P0: клик «Download» на рекомендованной карточке (до старта загрузки).
  const captureRecommendedClick = useCallback(
    (params: {
      modelId: string
      format: 'GGUF' | 'MLX'
      sizeGb?: number
      position: number
    }) => {
      try {
        posthog.capture('recommended_model_clicked', {
          model_id: params.modelId,
          size_gb: params.sizeGb ?? null,
          format: params.format,
          position: params.position,
          platform: getAnalyticsPlatform(),
          app_version: VERSION,
        })
      } catch (err) {
        console.debug('recommended_model_clicked telemetry failed:', err)
      }
    },
    []
  )

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
    const pending: typeof recommendedItems = []

    for (const item of recommendedItems) {
      const { model } = item
      if (!model) {
        pending.push(item)
        continue
      }
      const isMlx = !!model.is_mlx
      const variant = !isMlx ? pickPreferredVariant(model, item.rec.quant) : null
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
        pending.push(item)
      }
    }

    return { installedRecommended: installed, pendingRecommended: pending }
  }, [recommendedItems, isMlxDownloaded, isVariantDownloaded, getMlxModelId])

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
          description: error instanceof Error ? error.message : 'Unknown error',
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
        stepReached: 'model',
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
        stepReached: 'model',
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
          description: error instanceof Error ? error.message : 'Unknown error',
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
    try {
      posthog.capture('setup_local_model_autostarted', {
        source: autoRunTarget.source,
        format: autoRunTarget.format,
        size_gb: autoRunTarget.sizeBytes
          ? Math.round((autoRunTarget.sizeBytes / 1024 ** 3) * 100) / 100
          : null,
        detected_count: detectedRunnable.length,
        platform: getAnalyticsPlatform(),
        app_version: VERSION,
      })
    } catch (err) {
      console.debug('setup_local_model_autostarted telemetry failed:', err)
    }

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
        stepReached: 'model',
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
        void switchToModel({ modelId, providerName, serviceHub }).catch(() => {})
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

  // Leaving onboarding empty-handed. Since the Skip link was removed this is
  // reachable only through the auto-exit timeout — the `reason` is kept on the
  // event so the existing `setup_skipped` funnel stays comparable across the
  // change. Picking a model takes a different route (handleImportedId /
  // enterChatForDownload) and must not arm the bottom-right reminder.
  const leaveWithoutModel = useCallback(
    (reason: 'timeout') => {
      if (hasNavigatedRef.current) return
      hasNavigatedRef.current = true

      // Still import every detected model (no launch) before leaving onboarding.
      importCandidatesInBackground(localCandidates ?? [])
      try {
        const hadAnyModel = providers.some(
          (p) => (p.models?.length ?? 0) > 0 || !!p.api_key
        )
        posthog.capture('setup_skipped', {
          had_any_model: hadAnyModel,
          reason,
          platform: getAnalyticsPlatform(),
          app_version: VERSION,
        })
        captureOnboardingCompleted({
          exitPath: reason,
          hadAnyModel,
          stepReached: 'model',
          startedAtMs: onboardingStartedAtRef.current,
        })
      } catch (err) {
        console.debug('setup_skipped telemetry failed:', err)
      }
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

  // Read through a ref so the timeout below is armed once per model step
  // instead of being restarted every time a background import refreshes the
  // provider list.
  const leaveWithoutModelRef = useRef(leaveWithoutModel)
  useEffect(() => {
    leaveWithoutModelRef.current = leaveWithoutModel
  }, [leaveWithoutModel])

  // Armed only once the picker is actually on screen, and disarmed while an
  // import is in flight so a slow local model can't be cut short.
  useEffect(() => {
    // Do not start the 15s exit clock behind the loading screen.
    if (step !== 'model' || pickerInputsPending) return
    if (importingLocalId !== null) return
    // Onboarding must not navigate out from under an open dialog.
    if (cloudDialogOpen) return

    const timer = setTimeout(() => {
      // Second layer, deliberately: the dependency above cancels a pending
      // timer when the dialog opens, but a click at t≈14.99s can fire this
      // callback before React commits that state update.
      if (cloudDialogOpenRef.current) return
      leaveWithoutModelRef.current('timeout')
    }, MODEL_STEP_AUTO_EXIT_MS)

    return () => clearTimeout(timer)
  }, [step, pickerInputsPending, importingLocalId, cloudDialogOpen])

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
  const statusMessage =
    pickerInputsPending
      ? t('common:loading')
      : autoRunState === 'running' && autoRunTarget
        ? t('setup:localStep.autoStarting', {
            name: autoRunTarget.displayName,
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
                                  {cand.displayName}
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
                                    source: cand.source,
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
                                    {extractModelName(model.model_name)}
                                    {sizeLabel ? (
                                      <span className="text-xs font-normal text-muted-foreground">
                                        {' '}
                                        · {sizeLabel}
                                      </span>
                                    ) : null}
                                  </h2>
                                  <RecommendedModelChip
                                    className="mt-1 inline-flex max-w-full"
                                    variant={chipVariantForRecommendedDescriptionKey(
                                      rec.descriptionKey
                                    )}
                                    title={t(rec.descriptionKey)}
                                  >
                                    {t(rec.descriptionKey)}
                                  </RecommendedModelChip>
                                </div>
                              </div>
                              <div className="flex shrink-0 flex-col items-end gap-1">
                                <Button
                                  size="sm"
                                  disabled={importingLocalId !== null}
                                  onClick={() => {
                                    captureSetupLocalModelRun({
                                      trigger: 'installed_recommended',
                                      source: provider,
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

              <div className="flex flex-col gap-2">
                {pendingRecommended.length > 0 && (
                  <>
                    <span className="shrink-0 text-left text-xs font-medium text-muted-foreground">
                      {t('hub:recTitle')}
                    </span>
                    <div
                      className={cn(
                        'w-full shrink-0 rounded-lg border bg-secondary/50 px-3 py-2',
                        'max-h-[min(70vh,36rem)] overflow-y-auto overscroll-y-contain [scrollbar-gutter:stable]'
                      )}
                    >
                      <div className="flex flex-col divide-y divide-border/60">
                        {pendingRecommended.map(({ rec, model }, index) => {
                          const isMlx = !!model?.is_mlx
                          const variant =
                            model && !isMlx
                              ? pickPreferredVariant(model, rec.quant)
                              : null
                          //* Тот же проектор, что уйдёт в загрузку, — иначе
                          //* строка покажет размер одного файла, а скачается другой.
                          const mmproj =
                            model && !isMlx
                              ? pickMmprojModel(model, rec.mmprojQuant)
                              : undefined
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
                          const rowDownloading = rowTrackId
                            ? isVariantDownloading(rowTrackId)
                            : false
                          const rowDownloaded = isMlx
                            ? model
                              ? isMlxDownloaded(model)
                              : false
                            : model && variant
                              ? isVariantDownloaded(model, variant)
                              : false
                          const hfAuthor =
                            model?.developer?.trim() ||
                            rec.modelName.split('/')[0]?.trim() ||
                            ''
                          const nameForInitials =
                            extractModelName(rec.modelName) ||
                            rec.modelName ||
                            '?'
                          const rowInitials =
                            nameForInitials
                              .replace(/\.(gguf|GGUF)$/i, '')
                              .replace(/[^a-zA-Z0-9]/g, '')
                              .slice(0, 2) ||
                            hfAuthor.slice(0, 2) ||
                            '?'

                          const brandIconSrc = recommendedSetupModelIconSrc(
                            rec.modelName
                          )
                          const rowDownloadProgress = rowTrackId
                            ? downloadProcesses.find((p) => p.id === rowTrackId)
                            : undefined

                          return (
                            <div
                              key={`${rec.modelName}-${rec.descriptionKey}`}
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
                                    {model
                                      ? extractModelName(model.model_name)
                                      : extractModelName(rec.modelName)}
                                    {downloadSize ? (
                                      <span className="text-xs font-normal text-muted-foreground">
                                        {' '}
                                        · {downloadSize}
                                      </span>
                                    ) : null}
                                  </h2>
                                  <RecommendedModelChip
                                    className="mt-1 inline-flex max-w-full"
                                    variant={chipVariantForRecommendedDescriptionKey(
                                      rec.descriptionKey
                                    )}
                                    title={t(rec.descriptionKey)}
                                  >
                                    {t(rec.descriptionKey)}
                                  </RecommendedModelChip>
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
                                  disabled={
                                    !model ||
                                    (!isMlx && !variant) ||
                                    rowDownloading ||
                                    rowDownloaded
                                  }
                                  onClick={() => {
                                    if (!model) return
                                    // Detected-on-disk models still land in the
                                    // library even when the user downloads a
                                    // catalog model instead of running them.
                                    importCandidatesInBackground(
                                      localCandidates ?? []
                                    )
                                    if (isMlx) {
                                      captureRecommendedClick({
                                        modelId: getMlxModelId(model),
                                        format: 'MLX',
                                        sizeGb: sizeStringToGb(downloadSize),
                                        position: index,
                                      })
                                      void startMlxDownload(model)
                                      enterChatForDownload(
                                        getMlxModelId(model),
                                        'mlx'
                                      )
                                    } else if (variant) {
                                      captureRecommendedClick({
                                        modelId: variant.model_id,
                                        format: 'GGUF',
                                        sizeGb: sizeStringToGb(downloadSize),
                                        position: index,
                                      })
                                      startDownload(model, variant, mmproj?.path)
                                      enterChatForDownload(
                                        variant.model_id,
                                        LOCAL_LLAMACPP_PROVIDER as LocalLlamacppProvider
                                      )
                                    }
                                  }}
                                  className="shrink-0 rounded-full px-4"
                                >
                                  {/* Reserve width for the widest possible label so the
                                  button doesn't reflow when its state flips between
                                  Download / Downloading… / Downloaded. */}
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
                                    <span className="col-start-1 row-start-1">
                                      {rowDownloaded
                                        ? t('hub:downloaded')
                                        : rowDownloading
                                          ? t('setup:downloading')
                                          : t('hub:download')}
                                    </span>
                                  </span>
                                </Button>
                                {rowDownloading && rowTrackId ? (
                                  <p
                                    className="text-right text-xs text-muted-foreground tabular-nums"
                                    aria-live="polite"
                                  >
                                    {rowDownloadProgress &&
                                    rowDownloadProgress.total > 0
                                      ? `${Math.round((rowDownloadProgress.progress ?? 0) * 100)}% · ${formatDownloadGb(rowDownloadProgress.current)} / ${formatDownloadGb(rowDownloadProgress.total)} GB`
                                      : t('setup:downloadPreparing')}
                                  </p>
                                ) : null}
                              </div>
                            </div>
                          )
                        })}
                      </div>
                    </div>
                  </>
                )}

                {/* No Skip link: leaving empty-handed is handled by the
                    `MODEL_STEP_AUTO_EXIT_MS` timeout, so the screen offers only
                    the two ways to finish setup rather than a way to dodge it. */}
                <div className="relative z-60 flex shrink-0 flex-col items-center gap-3 pt-3">
                  {/* A user with no machine for local inference, or an existing
                      cloud subscription, would otherwise have nothing to pick.
                      The divider frames the two as alternatives rather than a
                      primary and an afterthought. */}
                  {hasCloudProviders && (
                    <>
                      <div className="flex w-full shrink-0 items-center gap-3">
                        <span className="bg-border h-px flex-1" />
                        <span className="text-muted-foreground text-xs">
                          {t('setup:orDivider')}
                        </span>
                        <span className="bg-border h-px flex-1" />
                      </div>
                      <Button
                        type="button"
                        variant="secondary"
                        size="sm"
                        onClick={() => setCloudDialog(true)}
                        className="relative z-60 shrink-0 rounded-full px-4"
                      >
                        <Cloud />
                        {t('setup:cloudStep.trigger')}
                      </Button>
                    </>
                  )}
                </div>
              </div>
            </div>
          </div>
        </div>
      </div>

      <AddCloudProviderDialog
        open={cloudDialogOpen}
        onOpenChange={setCloudDialog}
        onKeySaved={enterChatWithCloudProvider}
      />
    </div>
  )
}

export default SetupScreen
