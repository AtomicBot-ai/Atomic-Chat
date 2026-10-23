import { Button } from '@/components/ui/button'
import { route } from '@/constants/routes'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n'
import { DeleteModelAction } from '@/containers/hub/DeleteModelAction'
import { LargeModelWarningDialog } from '@/containers/hub/LargeModelWarningDialog'
import { ModelSetupSheet } from '@/containers/hub/ModelSetupSheet'
import { useCompatibilityVerdict } from '@/hooks/useModelSetup'
import {
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import {
  findInstalledLocalModel,
  LLAMACPP_PROVIDERS,
  quantModelIds,
} from '@/lib/hub-installed'
import {
  isPrismDownloadOnly,
  parseHubFileUrl,
  PRISM_PROVIDER,
  requiresPrism,
  routeForVerdict,
  setupErrorText,
} from '@/lib/model-setup'
import {
  loadPrismSetupPlan,
  prismSetupDeps,
  runPrismSetup,
  type PrismSetupStage,
} from '@/services/model-setup/prism-setup'
import type { PrismSetupPlan } from '@/services/model-setup/types'
import { CatalogModel } from '@/services/models/types'
import { useModelCompatibilityStore } from '@/stores/model-compatibility-store'
import { switchToModel } from '@/utils/switchModel'
import {
  IconDownload,
  IconLoader2,
  IconPlayerPlay,
  IconX,
} from '@tabler/icons-react'
import { useNavigate } from '@tanstack/react-router'
import { useCallback, useMemo, useState } from 'react'
import { toast } from 'sonner'

export const ModelDownloadAction = ({
  variant,
  model,
  asButton = false,
  deletable = false,
  warnTooLarge = false,
}: {
  variant: { model_id: string; path: string }
  model: CatalogModel
  // Render the idle state as a labelled primary "Download" button (Hub v12
  // variant rows) instead of the compact icon used elsewhere (SetupScreen).
  asButton?: boolean
  // Offer a trash button next to "New chat" once the variant is on disk. Opt-in
  // so the onboarding screens keep a single, unambiguous action.
  deletable?: boolean
  // The hardware-fit estimate calls this variant too large for the device:
  // Download asks first instead of starting (see LargeModelWarningDialog).
  warnTooLarge?: boolean
}) => {
  const serviceHub = useServiceHub()
  // The too-large warning, and which download it holds back until confirmed.
  const [warningFor, setWarningFor] = useState<'download' | 'setup' | null>(
    null
  )

  const { t } = useTranslation()
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)
  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
    pausedDownloads,
    downloadOriginByModelId,
    addLocalDownloadingModel,
    removeLocalDownloadingModel,
    markResumableDownload,
    clearResumableDownload,
    setDownloadOrigin,
    clearDownloadOrigin,
  } = useDownloadStore()
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

  const navigate = useNavigate()

  const handleUseModel = useCallback(
    (modelId: string, installedProvider?: string) => {
      // Resolve the target provider at click-time so we always see the
      // freshest providers/models snapshot — not whatever was captured at
      // render. Prefer the vanilla upstream `llama.cpp` provider when it
      // both exists AND has the model registered (currently macOS-only —
      // see AGENTS.md ADR 2026-05-19). If the model is not yet in the
      // upstream provider's list (e.g. its `list()` hasn't been refreshed
      // since download), fall back to `llamacpp` so the dropdown selection
      // and ChatInput auto-start effect on the home route can pick it up.
      const allProviders = useModelProvider.getState().providers
      const upstream = allProviders.find(
        (p) => p.provider === 'llamacpp-upstream'
      )
      const fork = allProviders.find((p) => p.provider === 'llamacpp')
      const upstreamHasModel = upstream?.models.some((m) => m.id === modelId)
      // Never route to a deactivated TurboQuant (disabled by default on
      // fresh installs) — the upstream tail of the ternary covers it.
      const forkUsable =
        fork?.active !== false && fork?.models.some((m) => m.id === modelId)
      // A Bonsai file the core set up lists only under PrismML; no other
      // engine may run it.
      const targetLlamaProvider:
        | 'llamacpp'
        | 'llamacpp-upstream'
        | typeof PRISM_PROVIDER =
        installedProvider === PRISM_PROVIDER
          ? PRISM_PROVIDER
          : upstreamHasModel
            ? 'llamacpp-upstream'
            : forkUsable
              ? 'llamacpp'
              : upstream
                ? 'llamacpp-upstream'
                : 'llamacpp'

      console.log(
        '[ModelDownloadAction] handleUseModel:',
        modelId,
        '→ provider:',
        targetLlamaProvider,
        '(upstreamHasModel:',
        upstreamHasModel,
        'forkUsable:',
        forkUsable,
        ')'
      )

      useModelProvider
        .getState()
        .selectModelProvider(targetLlamaProvider, modelId)
      switchToModel({
        modelId,
        providerName: targetLlamaProvider,
        serviceHub,
      }).catch((error) => {
        console.error('[ModelDownloadAction] switchToModel failed:', error)
      })
      navigate({
        to: route.home,
        params: {},
        search: {
          threadModel: {
            id: modelId,
            provider: targetLlamaProvider,
          },
        },
      })
    },
    [navigate, serviceHub]
  )

  const handleDownloadModel = useCallback(async () => {
    clearResumableDownload(variant.model_id)
    addLocalDownloadingModel(variant.model_id)
    setDownloadOrigin(variant.model_id, model.model_name)
    try {
      await serviceHub
        .models()
        .pullModelWithMetadata(
          variant.model_id,
          variant.path,
          (
            model.mmproj_models?.find(
              (e) => e.model_id.toLowerCase() === 'mmproj-f16'
            ) || model.mmproj_models?.[0]
          )?.path,
          huggingfaceToken,
          true,
          resumableDownloads.has(variant.model_id)
        )
    } catch (error) {
      // If pull rejects before any DownloadEvent fires, the global listener in
      // DownloadManegement.tsx never clears localDownloadingModels and the row
      // is stuck in a permanent "downloading" state. Clear it ourselves.
      console.error(
        '[ModelDownloadAction] pullModelWithMetadata failed:',
        error
      )
      removeLocalDownloadingModel(variant.model_id)
      clearDownloadOrigin(variant.model_id)
      markResumableDownload(variant.model_id)
      if (
        wasDownloadCancellationRequested(variant.model_id) ||
        isDownloadCancellationError(error)
      ) {
        return
      }
      toast.error(t('hub:downloadFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }, [
    serviceHub,
    variant.path,
    variant.model_id,
    huggingfaceToken,
    model.mmproj_models,
    model.model_name,
    addLocalDownloadingModel,
    removeLocalDownloadingModel,
    markResumableDownload,
    clearResumableDownload,
    setDownloadOrigin,
    clearDownloadOrigin,
    resumableDownloads,
    t,
  ])

  const hubFile = useMemo(() => parseHubFileUrl(variant.path), [variant.path])
  const verdict = useCompatibilityVerdict(variant.path)
  const [setupOpen, setSetupOpen] = useState(false)
  const [setupStarting, setSetupStarting] = useState(false)
  // Where a Bonsai setup is before its model download has a row of its own.
  const [prismStage, setPrismStage] = useState<PrismSetupStage | null>(null)
  const [engineProgress, setEngineProgress] = useState(0)
  const setupModelId = quantModelIds(model, variant.model_id)[1]
  const [sheetPlan, setSheetPlan] = useState<PrismSetupPlan | null>(null)
  // A file only PrismML runs downloads under the id the old core setup
  // registered it as, so a model set up before reads as downloaded. A
  // download already running under that id keeps the row on it even while
  // the verdict is being asked again (a new core generation forgets them).
  const prismDownloadRunning =
    localDownloadingModels.has(setupModelId) || setupModelId in downloads
  const rowModelId =
    requiresPrism(verdict) || prismDownloadRunning || prismStage !== null
      ? setupModelId
      : variant.model_id

  // Install the build when it is missing, make it active, download the model
  // and its projector under PrismML with the app's own downloader, then keep
  // the file only if the core says PrismML runs it.
  const runSetup = useCallback(
    async (plan: PrismSetupPlan) => {
      const id = plan.model_id
      let downloading = false
      setEngineProgress(0)
      try {
        const result = await runPrismSetup(
          plan,
          prismSetupDeps(serviceHub, {
            hfToken: huggingfaceToken,
            resume: resumableDownloads.has(id),
            onEngineProgress: ({ transferred, total }) =>
              setEngineProgress(total > 0 ? transferred / total : 0),
          }),
          (stage) => {
            setPrismStage(stage)
            if (stage !== 'downloading') return
            downloading = true
            clearResumableDownload(id)
            addLocalDownloadingModel(id)
            setDownloadOrigin(id, model.model_name)
          }
        )
        if (result.outcome === 'rejected')
          toast.error(t('hub:prismModelRejected'), {
            description: result.reason,
          })
      } catch (error) {
        console.error('[ModelDownloadAction] Bonsai setup failed:', error)
        if (downloading) {
          removeLocalDownloadingModel(id)
          clearDownloadOrigin(id)
          markResumableDownload(id)
        }
        if (
          wasDownloadCancellationRequested(id) ||
          isDownloadCancellationError(error) ||
          (error as { code?: unknown } | null)?.code === 'CANCELLED'
        )
          return
        toast.error(t('hub:downloadFailed'), {
          description: setupErrorText(error),
        })
      } finally {
        setPrismStage(null)
      }
    },
    [
      serviceHub,
      huggingfaceToken,
      resumableDownloads,
      model.model_name,
      clearResumableDownload,
      addLocalDownloadingModel,
      setDownloadOrigin,
      removeLocalDownloadingModel,
      clearDownloadOrigin,
      markResumableDownload,
      t,
    ]
  )

  // With PrismML already on disk the setup is only a download, so it starts
  // like one: no sheet, its progress on this row and in the download panel.
  // A plan that installs the engine, a newer one, or is blocked opens the
  // sheet instead.
  const startSetup = useCallback(async () => {
    if (!hubFile) return
    setSetupStarting(true)
    try {
      const plan = await loadPrismSetupPlan(serviceHub.modelSetup(), {
        ...hubFile,
        model_id: setupModelId,
        include_projector: true,
      })
      if (!isPrismDownloadOnly(plan)) {
        setSheetPlan(plan)
        setSetupOpen(true)
        return
      }
      void runSetup(plan)
    } catch (error) {
      console.error('[ModelDownloadAction] Bonsai plan failed:', error)
      toast.error(t('hub:downloadFailed'), {
        description: setupErrorText(error),
      })
    } finally {
      setSetupStarting(false)
    }
  }, [hubFile, serviceHub, setupModelId, runSetup, t])

  const requestDownload = useCallback(async () => {
    // The core's verdict decides the path when the Hub row has one; a row
    // clicked before its verdict arrived asks now. A core that cannot say
    // leaves the ordinary download, and the load gate still reads the header.
    let judged = verdict
    const service = serviceHub.modelSetup()
    if (judged === undefined && hubFile && service.isSupported()) {
      judged = await service
        .checkCompatibility({ ...hubFile, provider: 'llamacpp-upstream' })
        .catch(() => null)
      // The row follows the answer: a PrismML file's download has its own id.
      useModelCompatibilityStore.getState().setVerdict(variant.path, judged)
    }
    const route = judged ? routeForVerdict(judged) : 'download'
    if (route === 'refuse' && judged) {
      toast.error(t('hub:prismRefusedTitle'), {
        description: judged.replacement
          ? t('hub:prismRefusedReplacement', { file: judged.replacement })
          : judged.reason,
      })
      return
    }
    if (warnTooLarge) {
      setWarningFor(route === 'setup' ? 'setup' : 'download')
      return
    }
    if (route === 'setup') void startSetup()
    else void handleDownloadModel()
  }, [
    verdict,
    serviceHub,
    hubFile,
    variant.path,
    warnTooLarge,
    handleDownloadModel,
    startSetup,
    t,
  ])

  const handleCancelDownload = useCallback(() => {
    useDownloadStore
      .getState()
      .requestControl('cancel', { id: rowModelId, name: rowModelId })
  }, [rowModelId])

  // See ``DownloadButton.tsx`` for the rationale -- defensive UI guard
  // against catalog-level ``quant.model_id`` collisions across repos.
  const downloadOrigin = downloadOriginByModelId[rowModelId]
  const isOriginConflict =
    downloadOrigin !== undefined && downloadOrigin !== model.model_name
  const isDownloading =
    !isOriginConflict &&
    (localDownloadingModels.has(rowModelId) ||
      downloadProcesses.some((e) => e.id === rowModelId))
  const downloadProgress =
    downloadProcesses.find((e) => e.id === rowModelId)?.progress || 0
  // Inspect BOTH local llama.cpp providers — the turboquant `llamacpp` fork
  // AND the vanilla `llamacpp-upstream` build. On Windows/Linux the downloaded
  // model is registered under `llamacpp-upstream` (the default), so checking
  // only `llamacpp` left the button stuck on "Download" (mirrors handleUseModel
  // and hub/$modelId.tsx, which already consult both).
  const providers = useModelProvider((state) => state.providers)
  const installed = useMemo(
    () =>
      findInstalledLocalModel(
        providers,
        quantModelIds(model, variant.model_id),
        LLAMACPP_PROVIDERS
      ),
    [providers, model, variant.model_id]
  )
  const isDownloaded = installed !== null
  const setupSheet = hubFile ? (
    <ModelSetupSheet
      open={setupOpen}
      onOpenChange={setSetupOpen}
      file={hubFile}
      modelName={model.model_name}
      modelId={setupModelId}
      initialPlan={sheetPlan}
      onStart={(plan) => void runSetup(plan)}
    />
  ) : null

  // The PrismML build installs (its row is in the download panel, which
  // cancels it) and becomes active before the model download has a row.
  if (
    prismStage === 'installing_engine' ||
    prismStage === 'activating_engine'
  ) {
    const percent =
      prismStage === 'installing_engine'
        ? Math.round(engineProgress * 100)
        : 100
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        title={t('hub:prismStage_installing_engine')}
        aria-label={t('hub:prismStage_installing_engine')}
        className="relative w-24 justify-center overflow-hidden font-semibold"
        data-testid="model-setup-progress"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
          style={{ width: `${percent}%` }}
        />
        <span className="relative z-1 tabular-nums">{percent}%</span>
      </Button>
    )
  }

  // Building the plan from the core's answers, or checking the downloaded
  // file before it stays.
  if (setupStarting || prismStage === 'verifying') {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        disabled
        aria-label={t('hub:downloadModel')}
        className="w-24 justify-center"
        data-testid="model-setup-starting"
      >
        <IconLoader2 size={14} className="animate-spin" />
      </Button>
    )
  }

  // A paused download — also one a quit cut off, brought back after the
  // relaunch — offers Resume, as the download panel does: the transfer picks
  // up from the bytes on disk instead of the card's Cancel or a fresh Download.
  if (isDownloading && pausedDownloads.has(rowModelId)) {
    if (
      !useDownloadStore.getState().resumeParams[rowModelId] ||
      useDownloadStore.getState().downloads[rowModelId]?.recoveryBlocked
    ) {
      return (
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() =>
            window.dispatchEvent(new Event('atomic-open-download-panel'))
          }
          title={t('common:showDownloadProgress')}
          aria-label={t('common:showDownloadProgress')}
          className="w-24 justify-center"
        >
          <IconDownload size={14} />
        </Button>
      )
    }
    const label = t('common:resumeDownload')
    const percent = Math.round(downloadProgress * 100)
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={() =>
          useDownloadStore
            .getState()
            .requestControl('resume', { id: rowModelId, name: rowModelId })
        }
        title={label}
        aria-label={label}
        className="relative w-24 justify-center gap-1 overflow-hidden font-semibold"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 z-0 bg-primary/20"
          style={{ width: `${percent}%` }}
        />
        <IconPlayerPlay size={14} className="relative z-1" aria-hidden />
        <span className="relative z-1 tabular-nums">{percent}%</span>
      </Button>
    )
  }

  if (isDownloading) {
    return (
      <Button
        type="button"
        variant="outline"
        size="sm"
        onClick={handleCancelDownload}
        title={t('common:cancelDownload')}
        aria-label={t('common:cancelDownload')}
        className="group relative w-24 justify-center overflow-hidden font-semibold"
      >
        <span
          aria-hidden
          className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
          style={{ width: `${Math.round(downloadProgress * 100)}%` }}
        />
        <span className="relative z-1 tabular-nums transition-opacity group-hover:opacity-0">
          {Math.round(downloadProgress * 100)}%
        </span>
        <span className="absolute inset-0 z-1 flex items-center justify-center opacity-0 transition-opacity group-hover:opacity-100">
          <IconX size={14} />
        </span>
      </Button>
    )
  }

  if (isDownloaded && installed) {
    return (
      <div className="flex shrink-0 items-center gap-1">
        <Button
          variant="default"
          size="sm"
          onClick={() => handleUseModel(installed.modelId, installed.provider)}
          title={t('hub:useModel')}
        >
          {t('hub:newChat')}
        </Button>
        {deletable && (
          <DeleteModelAction
            modelId={installed.modelId}
            provider={installed.provider}
          />
        )}
      </div>
    )
  }

  const warningDialog = (
    <>
      <LargeModelWarningDialog
        open={warningFor !== null}
        onOpenChange={(open) => {
          if (!open) setWarningFor(null)
        }}
        onConfirm={() => {
          setWarningFor(null)
          if (warningFor === 'setup') void startSetup()
          else void handleDownloadModel()
        }}
      />
      {setupSheet}
    </>
  )
  // "Requires PrismML": the file runs only on PrismML's llama.cpp, which the
  // Download button sets up together with the model.
  const prismBadge = requiresPrism(verdict) ? (
    <span
      className="shrink-0 whitespace-nowrap rounded-sm border px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
      title={
        verdict?.outcome === 'engine_update_required'
          ? t('hub:prismEngineUpdateRequired')
          : t('hub:prismRequiredHint')
      }
      data-testid="requires-prism-badge"
    >
      <span data-testid="requires-prism-badge-label">
        {t('hub:prismRequired')}
      </span>
    </span>
  ) : null

  if (asButton) {
    return (
      <>
        {prismBadge}
        <Button
          type="button"
          variant="default"
          size="sm"
          onClick={() => void requestDownload()}
          title={t('hub:downloadModel')}
        >
          {t('hub:download')}
        </Button>
        {warningDialog}
      </>
    )
  }

  return (
    <>
      {prismBadge}
      <Button
        type="button"
        variant="ghost"
        size="icon-xs"
        aria-label={t('hub:downloadModel')}
        title={t('hub:downloadModel')}
        onClick={() => void requestDownload()}
      >
        <IconDownload size={16} className="text-muted-foreground" />
      </Button>
      {warningDialog}
    </>
  )
}
