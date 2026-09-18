import { useEffect, useMemo, useRef, useState } from 'react'
import { IconDownload, IconLoader2 } from '@tabler/icons-react'
import { EngineManager } from '@janhq/core'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'

import { Button } from '@/components/ui/button'
import { ModelLogo } from '@/containers/ModelLogo'
import { useDownloadStore, type DownloadStage } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
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
import { sanitizeModelId } from '@/lib/utils'
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
const HUGGING_FACE_ACTION_LABEL = 'Download models from Hugging Face'

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

/** Hugging Face results for the picker's explicitly entered download mode. */
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

  if (!eligible) return query.trim() ? noModels : null
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

export function HuggingFaceAction({ onClick }: { onClick: () => void }) {
  return (
    <div className="shrink-0 border-t p-1.5">
      <button
        type="button"
        aria-label={HUGGING_FACE_ACTION_LABEL}
        onClick={onClick}
        className="flex h-9 w-full items-center justify-center gap-2 rounded-md px-2 text-sm font-medium whitespace-nowrap text-muted-foreground transition-colors hover:bg-secondary/60 hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
        data-testid="model-picker-hugging-face-action"
      >
        <ModelLogo
          author="Hugging Face"
          fallback="huggingface"
          className="size-5 rounded-none border-0 bg-transparent dark:bg-transparent"
        />
        <span>{HUGGING_FACE_ACTION_LABEL}</span>
      </button>
    </div>
  )
}

/** Concise installed-model empty/search state; the footer owns the action. */
export function ModelPickerEmptyState({ query }: { query: string }) {
  const searching = query.trim().length > 0
  const { t } = useTranslation()
  return (
    <div className="px-3 py-4" data-testid="model-picker-empty">
      <StatusLine
        text={
          searching
            ? t('common:noModelsFoundFor', { searchValue: query })
            : 'No installed models yet.'
        }
      />
    </div>
  )
}
