import { useEffect, useMemo, useRef, useState, type ReactNode } from 'react'
import { IconDownload, IconLoader2 } from '@tabler/icons-react'
import { Cloud, FolderPlus, Search } from 'lucide-react'
import { EngineManager } from '@janhq/core'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'

import { ChatGptMark } from '@/components/icons/chatgpt-mark'
import { Button } from '@/components/ui/button'
import { ModelLogo } from '@/containers/ModelLogo'
import { RouteRow } from '@/containers/RouteRow'
import { selectCloudGalleryProviders } from '@/containers/dialogs/AddCloudProviderDialog'
import { useDownloadStore, type DownloadStage } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isProviderConnected } from '@/lib/cloud-providers'
import {
  cancelDownload,
  isDownloadCancellationError,
  wasDownloadCancellationRequested,
} from '@/lib/downloadCancellation'
import {
  downloadStatusLabel,
  formatEta,
  formatProgressPair,
} from '@/lib/downloadFormat'
import { getMemoryBudgetBytes, pickDownloadQuant } from '@/lib/model-card'
import { prettyModelName } from '@/lib/model-display-name'
import { getPreferredMmprojModel } from '@/lib/models'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { cn, sanitizeModelId } from '@/lib/utils'
import type {
  CatalogModel,
  HuggingFaceFeedFormat,
} from '@/services/models/types'

/** Keystrokes settle for this long before Hugging Face is asked. */
const HF_SEARCH_DEBOUNCE_MS = 300
/** Below this the service answers nothing anyway; mirrors `searchHuggingFaceCandidates`. */
const HF_MIN_QUERY_LENGTH = 3
/** Rows one search answers with. */
const HF_SEARCH_LIMIT = 6
/**
 * `HF_SEARCH_LIMIT` rows plus the card's padding, held from the card's first
 * empty frame: the status line, the rows and the "nothing found" line all
 * take the same room, so the routes under the card never move while the
 * user types, the search loads or the query is cleared.
 */
const HF_RESULTS_HEIGHT_CLASS = 'h-[21rem] min-h-[21rem] overflow-y-auto'
/** The subscription the routes offer by name — the reply gate's. */
const SUBSCRIPTION_PROVIDER = 'chatgpt'
/** `ModelLogo` drawn as a bare 32 px mark in a `RouteRow`'s icon slot. */
const MARK_CLASS =
  'size-8 rounded-full border-0 bg-transparent dark:bg-transparent'

// Module-level, like the Hub feed's detail cache: the list unmounts whenever
// the panel closes, and a repo resolved once must not be asked for again, nor
// a download started from here forgotten the moment the panel reopens.
const resolvedCards = new Map<string, CatalogModel>()
const startedVariantByRepo = new Map<string, string>()

// Test-only reset of the module caches above; not a component by design.
// eslint-disable-next-line react-refresh/only-export-components
export function resetModelPickerDownloadsForTest(): void {
  resolvedCards.clear()
  startedVariantByRepo.clear()
}

const candidateFormat = (candidate: CatalogModel) =>
  candidate.is_mlx ? 'MLX' : 'GGUF'
const candidateKey = (candidate: CatalogModel) =>
  `${candidate.model_name}:${candidateFormat(candidate)}`

function FormatBadge({ candidate }: { candidate: CatalogModel }) {
  return (
    <span className="shrink-0 rounded border bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground">
      {candidateFormat(candidate)}
    </span>
  )
}

type Translate = (key: string, vars?: Record<string, unknown>) => string

type InFlightDownload = {
  id: string
  progress: number
  current: number
  total: number
  bytesPerSecond: number
  stage?: DownloadStage
  paused: boolean
}

/**
 * The transfer behind one model id, as the bottom-right panel would list it:
 * the entry with progress, or the one started and not yet reporting a byte.
 * `null` while nothing is on its way.
 */
function useInFlightDownload(
  modelId: string | undefined
): InFlightDownload | null {
  const { downloads, localDownloadingModels, pausedDownloads } =
    useDownloadStore(
      useShallow((state) => ({
        downloads: state.downloads,
        localDownloadingModels: state.localDownloadingModels,
        pausedDownloads: state.pausedDownloads,
      }))
    )
  if (!modelId) return null
  const entry =
    downloads[modelId] ?? Object.values(downloads).find((d) => d.id === modelId)
  if (entry) {
    return {
      id: modelId,
      progress: entry.progress ?? 0,
      current: entry.current,
      total: entry.total,
      bytesPerSecond: entry.speed?.bytesPerSecond ?? 0,
      stage: entry.stage,
      paused: pausedDownloads.has(modelId),
    }
  }
  if (!localDownloadingModels.has(modelId)) return null
  return {
    id: modelId,
    progress: 0,
    current: 0,
    total: 0,
    bytesPerSecond: 0,
    paused: pausedDownloads.has(modelId),
  }
}

/**
 * The panel's readout on one line: `10% · 0.16 / 1.58 GB · 1m 00s left`,
 * `Paused · 0.16 / 1.58 GB`, or what the downloader is doing before the
 * first byte. The same line the reply gate shows, so one transfer never
 * reads differently between the two.
 */
function inFlightHint(t: Translate, download: InFlightDownload): string {
  const eta = download.paused
    ? null
    : formatEta(download.total - download.current, download.bytesPerSecond)
  return [
    downloadStatusLabel(t, download),
    download.total > 0 && formatProgressPair(download.current, download.total),
    eta && t('common:downloadPanel.left', { eta }),
  ]
    .filter(Boolean)
    .join(' · ')
}

function StatusLine({ text, spinning }: { text: string; spinning?: boolean }) {
  return (
    <div className="flex items-center gap-2 py-1.5 text-sm text-muted-foreground">
      {spinning && (
        <IconLoader2 size={14} className="shrink-0 animate-spin" aria-hidden />
      )}
      <span>{text}</span>
    </div>
  )
}

/**
 * A labelled card of rows — the reply gate's card, with the section label
 * onboarding puts over its list.
 */
function PickerSection({
  label,
  className,
  children,
  'data-testid': testId,
}: {
  'label'?: string
  'className'?: string
  'children': ReactNode
  'data-testid': string
}) {
  return (
    <section className="flex flex-col gap-1.5">
      {label && (
        <span className="px-1 text-xs font-medium text-muted-foreground">
          {label}
        </span>
      )}
      <div
        className={cn(
          'rounded-lg border bg-secondary/50 px-3 py-2 [&_.line-clamp-1]:truncate',
          className
        )}
        data-testid={testId}
      >
        {children}
      </div>
    </section>
  )
}

/**
 * A model's mark for a row. Through `ModelLogo` so single-colour marks
 * (Liquid's LFM among them) are tinted and survive a dark background; the
 * Hugging Face mark stands in for a family without a logo.
 */
const modelMark = (repo: string) => (
  <ModelLogo name={repo} fallback="huggingface" className={MARK_CLASS} />
)

type HuggingFaceStatus = 'idle' | 'searching' | 'done' | 'failed'

/** What Hugging Face answered, and to which query. */
type HuggingFaceAnswer = {
  query: string
  results: CatalogModel[]
  failed: boolean
}

/**
 * Hugging Face's compatible repos for the typed query, and the download behind
 * each — shared by the compact rows under the normal list and the panel
 * rows of the empty state.
 *
 * One request per supported format and settled query, never per keystroke — anonymous requests
 * are rate-limited per IP. A row knows only its repo until it is clicked:
 * the file to download is resolved then, from the repo's own listing, with
 * the same rule the Hub's download panel opens on (`pickDownloadQuant`), so
 * a click here fetches the file a click in the Hub would.
 */
function useHuggingFaceSearch(query: string) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const { total_memory, gpus } = useHardware(
    useShallow((s) => ({
      total_memory: s.hardwareData.total_memory,
      gpus: s.hardwareData.gpus,
    }))
  )
  const {
    resumableDownloads,
    addLocalDownloadingModel,
    removeLocalDownloadingModel,
    markResumableDownload,
    clearResumableDownload,
    setDownloadOrigin,
    clearDownloadOrigin,
  } = useDownloadStore(
    useShallow((state) => ({
      resumableDownloads: state.resumableDownloads,
      addLocalDownloadingModel: state.addLocalDownloadingModel,
      removeLocalDownloadingModel: state.removeLocalDownloadingModel,
      markResumableDownload: state.markResumableDownload,
      clearResumableDownload: state.clearResumableDownload,
      setDownloadOrigin: state.setDownloadOrigin,
      clearDownloadOrigin: state.clearDownloadOrigin,
    }))
  )

  const trimmed = query.trim()
  const eligible = trimmed.length >= HF_MIN_QUERY_LENGTH
  const [answer, setAnswer] = useState<HuggingFaceAnswer | null>(null)
  const [busyRepo, setBusyRepo] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // The answer to a query the user has since typed past is dropped, so a slow
  // early response cannot land on top of a fast later one.
  const ticketRef = useRef(0)

  useEffect(() => {
    const ticket = ++ticketRef.current
    if (!eligible) return
    const timer = setTimeout(() => {
      const formats: HuggingFaceFeedFormat[] = IS_MACOS
        ? ['gguf', 'mlx']
        : ['gguf']
      Promise.all(
        formats.map((format) =>
          serviceHub
            .models()
            .searchHuggingFaceCandidates(
              trimmed,
              huggingfaceToken,
              HF_SEARCH_LIMIT,
              format
            )
        )
      )
        .then((answers) => {
          if (ticket !== ticketRef.current) return
          // Interleave formats so six popular GGUF repos cannot bury MLX.
          const found = Array.from({ length: HF_SEARCH_LIMIT }, (_, index) =>
            answers.flatMap((rows) => (rows[index] ? [rows[index]] : []))
          ).flat()
          const unique = new Map(
            found
              .filter((m) => IS_MACOS || !m.is_mlx)
              .map((m) => [candidateKey(m), m])
          )
          setAnswer({
            query: trimmed,
            results: [...unique.values()],
            failed: false,
          })
        })
        .catch(() => {
          if (ticket !== ticketRef.current) return
          setAnswer({ query: trimmed, results: [], failed: true })
        })
    }, HF_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [eligible, trimmed, huggingfaceToken, serviceHub])

  // An answer counts only for the query it was asked about: once the user
  // has typed past it the search is under way again, and yesterday's rows
  // must not stand in for today's.
  const settled = eligible && answer?.query === trimmed ? answer : null
  const status: HuggingFaceStatus = !eligible
    ? 'idle'
    : !settled
      ? 'searching'
      : settled.failed
        ? 'failed'
        : 'done'
  const results = useMemo(
    () => (settled && !settled.failed ? settled.results : []),
    [settled]
  )

  // `fetchHuggingFaceRepo` answers `null` for a repo it could not fetch as
  // well as for one that does not exist, so a miss is not cached: the next
  // click may be online.
  const resolveCard = async (
    candidate: CatalogModel
  ): Promise<CatalogModel | null> => {
    const repo = candidate.model_name
    const key = candidateKey(candidate)
    const cached = resolvedCards.get(key)
    if (cached) return cached
    const repoInfo = await serviceHub
      .models()
      .fetchHuggingFaceRepo(repo, huggingfaceToken)
    if (!repoInfo) return null
    const catalog = serviceHub.models().convertHfRepoToCatalogModel(repoInfo)
    const card: CatalogModel = {
      ...catalog,
      model_name: repo,
      is_mlx: candidate.is_mlx,
      quants: catalog.quants?.map((quant) => ({
        ...quant,
        model_id: sanitizeModelId(quant.model_id),
      })),
    }
    resolvedCards.set(key, card)
    return card
  }

  const download = async (candidate: CatalogModel) => {
    const repo = candidate.model_name
    if (busyRepo) return
    const key = candidateKey(candidate)
    setBusyRepo(key)
    let variantId: string | undefined
    try {
      if (candidate.is_mlx) {
        if (!IS_MACOS) return
        const repoInfo = await serviceHub
          .models()
          .fetchHuggingFaceRepo(repo, huggingfaceToken)
        if (!repoInfo)
          throw new Error(t('common:modelPicker.huggingFaceUnavailable'))
        const files = repoInfo.siblings ?? []
        const main = files.find((file) =>
          file.rfilename.toLowerCase().endsWith('.safetensors')
        )
        if (!main) {
          setUnavailable((prev) => new Set(prev).add(key))
          return
        }
        const engine = EngineManager.instance().get('mlx')
        if (!engine) throw new Error(t('common:modelPicker.mlxUnavailable'))
        variantId = sanitizeModelId(repo.split('/').pop() ?? repo)
        startedVariantByRepo.set(key, variantId)
        clearResumableDownload(variantId)
        addLocalDownloadingModel(variantId)
        setDownloadOrigin(variantId, repo)
        await engine.import(variantId, {
          modelPath: `https://huggingface.co/${repo}/resolve/main/${main.rfilename}`,
          files: files
            .filter(
              (file) =>
                file !== main && !file.rfilename.toLowerCase().endsWith('.gguf')
            )
            .map((file) => ({
              url: `https://huggingface.co/${repo}/resolve/main/${file.rfilename}`,
              filename: file.rfilename,
            })),
          resume: resumableDownloads.has(variantId),
        })
        return
      }
      const card = await resolveCard(candidate)
      if (!card) {
        toast.error(t('hub:downloadFailed'), {
          description: t('common:modelPicker.huggingFaceUnavailable'),
        })
        return
      }
      // The file the Hub's download panel would open on for this device.
      const variant = pickDownloadQuant(
        card,
        getMemoryBudgetBytes({ total_memory, gpus })
      )
      if (!variant) {
        setUnavailable((prev) => new Set(prev).add(key))
        return
      }
      variantId = variant.model_id
      startedVariantByRepo.set(key, variantId)
      clearResumableDownload(variantId)
      addLocalDownloadingModel(variantId)
      setDownloadOrigin(variantId, card.model_name)
      await serviceHub
        .models()
        .pullModelWithMetadata(
          variantId,
          variant.path,
          getPreferredMmprojModel(card)?.path,
          huggingfaceToken,
          true,
          resumableDownloads.has(variantId)
        )
    } catch (error) {
      // Same recovery as `ModelDownloadAction`: a pull that rejects before any
      // download event fires would otherwise leave the row "downloading".
      console.error('[ModelPickerDownloads] download failed:', error)
      if (variantId) {
        removeLocalDownloadingModel(variantId)
        clearDownloadOrigin(variantId)
        markResumableDownload(variantId)
        if (
          wasDownloadCancellationRequested(variantId) ||
          isDownloadCancellationError(error)
        ) {
          return
        }
      }
      toast.error(t('hub:downloadFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyRepo(null)
    }
  }

  return { eligible, status, results, busyRepo, unavailable, download }
}

/**
 * One Hugging Face repo in the normal list's own compact row shape: a name,
 * one line under it, and the verb. The size stays off the button — it would
 * cost a request per row — and the line carries the progress once the
 * download runs.
 */
function PickerDownloadRow({
  candidate,
  title,
  hint,
  label,
  disabled,
  busy,
  onDownload,
}: {
  candidate: CatalogModel
  title: string
  hint: string
  label: string
  disabled: boolean
  /** The click is being resolved: the button waits instead of firing twice. */
  busy?: boolean
  onDownload: () => void
}) {
  return (
    <div
      className="mx-1 mb-1 flex items-center gap-2 rounded-sm px-2 py-1.5"
      data-testid="model-picker-download-row"
    >
      <div className="min-w-0 flex-1">
        <span className="flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate text-sm" title={title}>
            {title}
          </span>
          <FormatBadge candidate={candidate} />
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {hint}
        </span>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="icon-sm"
        aria-label={label}
        disabled={disabled || busy}
        onClick={onDownload}
        className="size-8 shrink-0 rounded-full"
      >
        {busy ? (
          <span className="flex size-4 items-center justify-center bg-transparent">
            <IconLoader2 className="size-3.5 animate-spin" aria-hidden />
          </span>
        ) : (
          <IconDownload size={15} aria-hidden />
        )}
      </Button>
    </div>
  )
}

function HuggingFaceRow({
  candidate,
  busy,
  unavailable,
  onDownload,
}: {
  candidate: CatalogModel
  busy: boolean
  unavailable: boolean
  onDownload: () => void
}) {
  const { t } = useTranslation()
  const repo = candidate.model_name
  const title = prettyModelName(repo) || repo
  const inFlight = useInFlightDownload(
    startedVariantByRepo.get(candidateKey(candidate))
  )
  const hint = inFlight
    ? inFlightHint(t, inFlight)
    : unavailable
      ? t(
          candidate.is_mlx
            ? 'common:modelPicker.noMlxFile'
            : 'common:modelPicker.noGgufFile'
        )
      : repo
  return (
    <PickerDownloadRow
      candidate={candidate}
      title={title}
      hint={hint}
      label={`${t('chat:replyGate.downloadLabel', { name: title })} (${candidateFormat(candidate)})`}
      disabled={inFlight !== null || unavailable}
      busy={busy}
      onDownload={onDownload}
    />
  )
}

/**
 * Hugging Face's compatible repos for the typed query, under the local matches of
 * the normal list — a search with no local hit was a dead end ("No models
 * found") with nothing to download from.
 *
 * The local "No models found" line survives only when both sides have
 * nothing; a search that could not reach Hugging Face says that instead.
 */
export function HuggingFacePicks({
  query,
  localEmpty,
}: {
  query: string
  /** No local model matched the query. */
  localEmpty: boolean
}) {
  const { t } = useTranslation()
  const { eligible, status, results, busyRepo, unavailable, download } =
    useHuggingFaceSearch(query)

  const noModels = localEmpty ? (
    <div className="px-2">
      <StatusLine text={t('common:noModelsFoundFor', { searchValue: query })} />
    </div>
  ) : null

  if (!eligible) return noModels
  if (status === 'searching') {
    return (
      <div className="px-2">
        <StatusLine
          text={t('common:modelPicker.searchingHuggingFace')}
          spinning
        />
      </div>
    )
  }
  if (status === 'failed') {
    return (
      <div className="px-2">
        <StatusLine text={t('common:modelPicker.huggingFaceUnavailable')} />
      </div>
    )
  }
  if (results.length === 0) return noModels

  return (
    <div
      className="mx-1.5 my-1.5 rounded-sm bg-secondary/30 py-1"
      data-testid="model-picker-hugging-face"
    >
      <div className="px-2 py-1 text-sm font-medium text-muted-foreground">
        {t('common:modelPicker.huggingFace')}
      </div>
      {results.map((candidate) => (
        <HuggingFaceRow
          key={candidateKey(candidate)}
          candidate={candidate}
          busy={busyRepo === candidateKey(candidate)}
          unavailable={unavailable.has(candidateKey(candidate))}
          onDownload={() => void download(candidate)}
        />
      ))}
    </div>
  )
}

/**
 * One Hugging Face repo as a panel row: the same shape as the recommended
 * rows above it — mark, name, the repo id as its line, Download — and the
 * same Cancel once its download runs. Plain "Download": the size is not
 * known until the repo is resolved on the click.
 */
function HuggingFaceRouteRow({
  candidate,
  busy,
  unavailable,
  onDownload,
}: {
  candidate: CatalogModel
  busy: boolean
  unavailable: boolean
  onDownload: () => void
}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const repo = candidate.model_name
  const title = prettyModelName(repo) || repo
  const inFlight = useInFlightDownload(
    startedVariantByRepo.get(candidateKey(candidate))
  )
  return (
    <RouteRow
      compact
      icon={modelMark(repo)}
      title={title}
      meta={<FormatBadge candidate={candidate} />}
      hint={
        inFlight
          ? inFlightHint(t, inFlight)
          : unavailable
            ? t(
                candidate.is_mlx
                  ? 'common:modelPicker.noMlxFile'
                  : 'common:modelPicker.noGgufFile'
              )
            : repo
      }
      action={
        inFlight ? (
          t('common:cancel')
        ) : busy ? (
          <IconLoader2 className="animate-spin" aria-hidden />
        ) : (
          <IconDownload size={15} aria-hidden />
        )
      }
      label={
        inFlight
          ? t('common:cancelDownload')
          : `${t('chat:replyGate.downloadLabel', { name: title })} (${candidateFormat(candidate)})`
      }
      disabled={!inFlight && (busy || unavailable)}
      textAction={Boolean(inFlight)}
      iconAction={!inFlight}
      onClick={() => {
        if (inFlight) {
          cancelDownload({ id: inFlight.id, name: inFlight.id }, serviceHub)
          return
        }
        onDownload()
      }}
      data-testid="model-picker-hugging-face-row"
    />
  )
}

/**
 * The search's answer in the empty state, in the recommendations' place: a
 * card that reserves the rows' height before it has any, so the status
 * line, the rows and the "nothing found" line all take the same room.
 */
function HuggingFaceResults({ query }: { query: string }) {
  const { t } = useTranslation()
  const { eligible, status, results, busyRepo, unavailable, download } =
    useHuggingFaceSearch(query)

  let body: ReactNode
  if (!eligible || (status === 'done' && results.length === 0)) {
    body = (
      <StatusLine text={t('common:noModelsFoundFor', { searchValue: query })} />
    )
  } else if (status === 'searching') {
    body = (
      <StatusLine
        text={t('common:modelPicker.searchingHuggingFace')}
        spinning
      />
    )
  } else if (status === 'failed') {
    body = <StatusLine text={t('common:modelPicker.huggingFaceUnavailable')} />
  } else {
    body = (
      <div className="flex flex-col divide-y divide-border/60">
        {results.map((candidate) => (
          <HuggingFaceRouteRow
            key={candidateKey(candidate)}
            candidate={candidate}
            busy={busyRepo === candidateKey(candidate)}
            unavailable={unavailable.has(candidateKey(candidate))}
            onDownload={() => void download(candidate)}
          />
        ))}
      </div>
    )
  }

  return (
    <PickerSection
      label={t('common:modelPicker.huggingFace')}
      className={HF_RESULTS_HEIGHT_CLASS}
      data-testid="model-picker-hugging-face"
    >
      {body}
    </PickerSection>
  )
}

/**
 * The other ways to get a model, as rows — the reply gate's `ModelRoutes`,
 * row for row, so the selector, the reply gate and onboarding read as one
 * product. Each cloud route is hidden only when it cannot do anything: the
 * API-key route when no cloud provider is connectable at all, the
 * subscription when this platform cannot serve the OAuth callback or the
 * account is already signed in. The Hub route is always there.
 */
function PickerRoutes({
  onBrowseHuggingFace,
  onConnectCloud,
  onConnectSubscription,
  onImportLocal,
}: {
  onBrowseHuggingFace: () => void
  onConnectCloud: () => void
  onConnectSubscription: () => void
  onImportLocal: () => void
}) {
  const { t } = useTranslation()
  const providers = useModelProvider((state) => state.providers)

  const hasCloudProviders = useMemo(
    () => selectCloudGalleryProviders(providers).length > 0,
    [providers]
  )

  const subscriptionOffered = useMemo(() => {
    if (!PlatformFeatures[PlatformFeature.CHATGPT_SUBSCRIPTION]) return false
    const provider = providers.find((p) => p.provider === SUBSCRIPTION_PROVIDER)
    return !!provider && !isProviderConnected(provider)
  }, [providers])

  return (
    <div
      className="overflow-y-auto rounded-lg border bg-secondary/50 px-3 py-2 [scrollbar-gutter:stable]"
      data-testid="model-picker-routes"
    >
      <div className="flex flex-col divide-y divide-border/60">
        <RouteRow
          layout="onboarding"
          compact
          icon={<Search />}
          title={t('setup:cloudStep.huggingFaceTitle')}
          hint={t('setup:cloudStep.huggingFaceHint')}
          action={t('setup:cloudStep.browse')}
          label={t('setup:cloudStep.huggingFaceTrigger')}
          onClick={onBrowseHuggingFace}
          data-testid="model-picker-hugging-face-route"
        />
        {subscriptionOffered && (
          <RouteRow
            layout="onboarding"
            compact
            icon={<ChatGptMark />}
            title={t('setup:cloudStep.subscriptionTitle')}
            hint={t('setup:cloudStep.subscriptionHint')}
            action={t('setup:cloudStep.connect')}
            label={t('setup:cloudStep.subscriptionTrigger')}
            onClick={onConnectSubscription}
            data-testid="model-picker-subscription"
          />
        )}
        {hasCloudProviders && (
          <RouteRow
            layout="onboarding"
            compact
            icon={<Cloud />}
            title={t('setup:cloudStep.providerTitle')}
            hint={t('setup:cloudStep.providerHint')}
            action={t('setup:cloudStep.addApiKey')}
            label={t('setup:cloudStep.trigger')}
            onClick={onConnectCloud}
            data-testid="model-picker-cloud-key"
          />
        )}
        <RouteRow
          layout="onboarding"
          compact
          icon={<FolderPlus />}
          title={t('chat:replyGate.folderTitle')}
          hint={t('chat:replyGate.folderHint')}
          action={t('setup:cloudStep.add')}
          label={t('chat:replyGate.addFolder')}
          onClick={onImportLocal}
          data-testid="model-picker-local-import"
        />
      </div>
    </div>
  )
}

/**
 * What the composer's model list shows when there is nothing to pick: the
 * reply gate's list, in the panel. The recommended models for this machine
 * under their label, then the other ways to get one; a typed query swaps
 * the recommendations for Hugging Face's answer and leaves the routes where
 * they were. The panel is the download — there is no second "Download a
 * model" row under it.
 */
export function ModelPickerEmptyState({
  query,
  onBrowseHuggingFace,
  onConnectCloud,
  onConnectSubscription,
  onImportLocal,
}: {
  query: string
  onBrowseHuggingFace: () => void
  onConnectCloud: () => void
  onConnectSubscription: () => void
  onImportLocal: () => void
}) {
  const searching = query.trim().length > 0
  return (
    <div className="flex flex-col gap-2 p-2" data-testid="model-picker-empty">
      {searching ? (
        <HuggingFaceResults query={query} />
      ) : (
        <PickerRoutes
          onBrowseHuggingFace={onBrowseHuggingFace}
          onConnectCloud={onConnectCloud}
          onConnectSubscription={onConnectSubscription}
          onImportLocal={onImportLocal}
        />
      )}
    </div>
  )
}
