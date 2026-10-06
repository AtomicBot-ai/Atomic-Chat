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
import {
  useCompatibilityVerdict,
  useHubFileSetup,
  useModelSetupBytes,
} from '@/hooks/useModelSetup'
import {
  isDownloadCancellationError,
  markDownloadCancellationRequested,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import {
  findInstalledLocalModel,
  LLAMACPP_PROVIDERS,
  quantModelIds,
} from '@/lib/hub-installed'
import {
  isFinalSetup,
  parseHubFileUrl,
  PRISM_PROVIDER,
  requiresPrism,
  routeForVerdict,
} from '@/lib/model-setup'
import { CatalogModel } from '@/services/models/types'
import { switchToModel } from '@/utils/switchModel'
import { IconDownload, IconX } from '@tabler/icons-react'
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
  const [warningOpen, setWarningOpen] = useState(false)

  const { t } = useTranslation()
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)
  const {
    downloads,
    localDownloadingModels,
    resumableDownloads,
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
  const setup = useHubFileSetup(hubFile)
  const setupBytes = useModelSetupBytes(setup)
  const [setupOpen, setSetupOpen] = useState(false)

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
    }
    const route = judged ? routeForVerdict(judged) : 'download'
    if (route === 'setup') {
      setSetupOpen(true)
      return
    }
    if (route === 'refuse' && judged) {
      toast.error(t('hub:prismRefusedTitle'), {
        description: judged.replacement
          ? t('hub:prismRefusedReplacement', { file: judged.replacement })
          : judged.reason,
      })
      return
    }
    if (warnTooLarge) {
      setWarningOpen(true)
      return
    }
    void handleDownloadModel()
  }, [verdict, serviceHub, hubFile, warnTooLarge, handleDownloadModel, t])

  const handleCancelDownload = useCallback(() => {
    markResumableDownload(variant.model_id)
    markDownloadCancellationRequested(variant.model_id)
    void serviceHub.models().abortDownload(variant.model_id)
  }, [markResumableDownload, serviceHub, variant.model_id])

  // See ``DownloadButton.tsx`` for the rationale -- defensive UI guard
  // against catalog-level ``quant.model_id`` collisions across repos.
  const downloadOrigin = downloadOriginByModelId[variant.model_id]
  const isOriginConflict =
    downloadOrigin !== undefined && downloadOrigin !== model.model_name
  const isDownloading =
    !isOriginConflict &&
    (localDownloadingModels.has(variant.model_id) ||
      downloadProcesses.some((e) => e.id === variant.model_id))
  const downloadProgress =
    downloadProcesses.find((e) => e.id === variant.model_id)?.progress || 0
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
  const setupModelId = quantModelIds(model, variant.model_id)[1]
  const setupSheet = hubFile ? (
    <ModelSetupSheet
      open={setupOpen}
      onOpenChange={setSetupOpen}
      file={hubFile}
      modelName={model.model_name}
      modelId={setupModelId}
      installed={isDownloaded}
      onReady={(modelId) => {
        setSetupOpen(false)
        handleUseModel(modelId, PRISM_PROVIDER)
      }}
    />
  ) : null

  // A setup the core is still running (or that waits for `resume`) is this
  // row's download: the button follows it and opens the sheet.
  if (setup && !isFinalSetup(setup) && !isDownloaded) {
    const percent =
      setupBytes.total > 0
        ? Math.round((setupBytes.transferred / setupBytes.total) * 100)
        : 0
    return (
      <>
        <Button
          type="button"
          variant="outline"
          size="sm"
          onClick={() => setSetupOpen(true)}
          title={t('hub:prismSetupOpen')}
          aria-label={t('hub:prismSetupOpen')}
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
        {setupSheet}
      </>
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
        open={warningOpen}
        onOpenChange={setWarningOpen}
        onConfirm={() => {
          setWarningOpen(false)
          void handleDownloadModel()
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
        size="icon-sm"
        aria-label={t('hub:downloadModel')}
        title={t('hub:downloadModel')}
        onClick={() => void requestDownload()}
        className="size-6"
      >
        <IconDownload size={16} className="text-muted-foreground" />
      </Button>
      {warningDialog}
    </>
  )
}
