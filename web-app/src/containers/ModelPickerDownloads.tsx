import { useEffect, useRef, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import { toast } from 'sonner'
import { useShallow } from 'zustand/shallow'

import { Button } from '@/components/ui/button'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useRecommendedDownloads } from '@/hooks/useRecommendedDownloads'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getMemoryBudgetBytes, pickDownloadQuant } from '@/lib/model-card'
import { prettyModelName } from '@/lib/model-display-name'
import { getPreferredMmprojModel } from '@/lib/models'
import { sanitizeModelId } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'

/** How long the recommendation may take to resolve before the list stops waiting. */
const RECOMMENDATION_WAIT_MS = 8_000
/** Keystrokes settle for this long before Hugging Face is asked. */
const HF_SEARCH_DEBOUNCE_MS = 300
/** Below this the service answers nothing anyway; mirrors `searchHuggingFaceCandidates`. */
const HF_MIN_QUERY_LENGTH = 3
/** Rows the panel has room for under the local results. */
const HF_SEARCH_LIMIT = 6

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

/**
 * One downloadable row in the composer's model list: a name, one line under
 * it, and the verb. The size stays off the button (the hint carries the
 * progress once the download runs), and the row keeps the list's own compact
 * shape rather than the dialog rows of `RouteRow`.
 */
function PickerDownloadRow({
  title,
  hint,
  label,
  disabled,
  busy,
  onDownload,
}: {
  title: string
  hint: string
  label: string
  disabled: boolean
  /** The click is being resolved: the button waits instead of firing twice. */
  busy?: boolean
  onDownload: () => void
}) {
  const { t } = useTranslation()
  return (
    <div
      className="mx-1 mb-1 flex items-center gap-2 rounded-sm px-2 py-1.5"
      data-testid="model-picker-download-row"
    >
      <div className="min-w-0 flex-1">
        <span className="block truncate text-sm" title={title}>
          {title}
        </span>
        <span className="block truncate text-xs text-muted-foreground">
          {hint}
        </span>
      </div>
      <Button
        type="button"
        variant="secondary"
        size="xs"
        aria-label={label}
        disabled={disabled || busy}
        onClick={onDownload}
        className="shrink-0 rounded-full"
      >
        {busy ? (
          <IconLoader2 className="animate-spin" aria-hidden />
        ) : (
          t('chat:replyGate.download')
        )}
      </Button>
    </div>
  )
}

function StatusLine({ text, spinning }: { text: string; spinning?: boolean }) {
  return (
    <div className="flex items-center gap-2 px-4 py-3 text-sm text-muted-foreground">
      {spinning && (
        <IconLoader2 size={14} className="shrink-0 animate-spin" aria-hidden />
      )}
      <span>{text}</span>
    </div>
  )
}

/** "Downloading… 42%" while bytes arrive, "Downloading…" before the first. */
function useDownloadingHint(variantId: string | undefined): string | null {
  const { t } = useTranslation()
  const { downloads, localDownloadingModels } = useDownloadStore(
    useShallow((state) => ({
      downloads: state.downloads,
      localDownloadingModels: state.localDownloadingModels,
    }))
  )
  if (!variantId) return null
  const entry = Object.values(downloads).find((d) => d.id === variantId)
  if (!entry && !localDownloadingModels.has(variantId)) return null
  if (!entry || entry.total <= 0) return t('chat:replyGate.downloading')
  return t('chat:replyGate.downloadingPercent', {
    percent: Math.round((entry.progress ?? 0) * 100),
  })
}

function RecommendedRow({
  item,
}: {
  item: ReturnType<typeof useRecommendedDownloads>['items'][number]
}) {
  const { t } = useTranslation()
  const downloadingHint = useDownloadingHint(item.variant.model_id)
  const hint =
    item.isDownloading || downloadingHint
      ? (downloadingHint ?? t('chat:replyGate.downloading'))
      : t(item.descriptionKey)
  return (
    <PickerDownloadRow
      title={item.title}
      hint={hint}
      label={t('chat:replyGate.downloadLabel', { name: item.title })}
      disabled={item.isDownloading || downloadingHint !== null}
      onDownload={() => {
        item.start()
      }}
    />
  )
}

/**
 * What the list shows when there is nothing to pick: the manifest's best fit
 * for this machine, the same rows the blocked-send widget recommends, so the
 * empty selector leads somewhere instead of to a blank panel. GGUF only, as
 * the hook already guarantees. While the lead is unresolved a spinner line
 * stands in; after the widget's 8 s budget it comes down and the bottom
 * "Download a model" row is the offer.
 */
export function RecommendedPicks() {
  const { t } = useTranslation()
  const { items, isLoading } = useRecommendedDownloads()
  const [gaveUp, setGaveUp] = useState(false)
  useEffect(() => {
    if (!isLoading || gaveUp) return
    const timer = setTimeout(() => setGaveUp(true), RECOMMENDATION_WAIT_MS)
    return () => clearTimeout(timer)
  }, [isLoading, gaveUp])

  if (items.length === 0) {
    if (!isLoading || gaveUp) return null
    return (
      <StatusLine text={t('chat:replyGate.findingRecommendation')} spinning />
    )
  }

  return (
    <div
      className="mx-1.5 my-1.5 rounded-sm bg-secondary/30 py-1"
      data-testid="model-picker-recommended"
    >
      <div className="px-2 py-1 text-sm font-medium text-muted-foreground">
        {t('chat:replyGate.recommendedForDevice')}
      </div>
      {items.map((item) => (
        <RecommendedRow key={item.repo} item={item} />
      ))}
    </div>
  )
}

type HuggingFaceStatus = 'idle' | 'searching' | 'done' | 'failed'

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
  const downloadingHint = useDownloadingHint(startedVariantByRepo.get(repo))
  const hint = downloadingHint
    ? downloadingHint
    : unavailable
      ? t('common:modelPicker.noGgufFile')
      : repo
  return (
    <PickerDownloadRow
      title={title}
      hint={hint}
      label={t('chat:replyGate.downloadLabel', { name: title })}
      disabled={downloadingHint !== null || unavailable}
      busy={busy}
      onDownload={onDownload}
    />
  )
}

/**
 * Hugging Face's GGUF repos for the typed query, under the local matches.
 *
 * One request per settled query, never per keystroke — anonymous requests
 * are rate-limited per IP. A row knows only its repo until it is clicked:
 * the file to download is resolved then, from the repo's own listing, with
 * the same rule the Hub's download panel opens on (`pickDownloadQuant`), so
 * a click here fetches the file a click in the Hub would.
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
  const [results, setResults] = useState<CatalogModel[]>([])
  const [status, setStatus] = useState<HuggingFaceStatus>('idle')
  const [busyRepo, setBusyRepo] = useState<string | null>(null)
  const [unavailable, setUnavailable] = useState<ReadonlySet<string>>(
    () => new Set()
  )
  // The answer to a query the user has since typed past is dropped, so a slow
  // early response cannot land on top of a fast later one.
  const ticketRef = useRef(0)

  useEffect(() => {
    const ticket = ++ticketRef.current
    if (!eligible) {
      setResults([])
      setStatus('idle')
      return
    }
    setStatus('searching')
    const timer = setTimeout(() => {
      serviceHub
        .models()
        .searchHuggingFaceCandidates(trimmed, huggingfaceToken, HF_SEARCH_LIMIT)
        .then((found) => {
          if (ticket !== ticketRef.current) return
          // GGUF only: an MLX repo has no file this row could fetch.
          setResults(found.filter((m) => !m.is_mlx))
          setStatus('done')
        })
        .catch(() => {
          if (ticket !== ticketRef.current) return
          setResults([])
          setStatus('failed')
        })
    }, HF_SEARCH_DEBOUNCE_MS)
    return () => clearTimeout(timer)
  }, [eligible, trimmed, huggingfaceToken, serviceHub])

  // `fetchHuggingFaceRepo` answers `null` for a repo it could not fetch as
  // well as for one that does not exist, so a miss is not cached: the next
  // click may be online.
  const resolveCard = async (repo: string): Promise<CatalogModel | null> => {
    const cached = resolvedCards.get(repo)
    if (cached) return cached
    const repoInfo = await serviceHub
      .models()
      .fetchHuggingFaceRepo(repo, huggingfaceToken)
    if (!repoInfo) return null
    const catalog = serviceHub.models().convertHfRepoToCatalogModel(repoInfo)
    const card: CatalogModel = {
      ...catalog,
      model_name: repo,
      quants: catalog.quants?.map((quant) => ({
        ...quant,
        model_id: sanitizeModelId(quant.model_id),
      })),
    }
    resolvedCards.set(repo, card)
    return card
  }

  const download = async (candidate: CatalogModel) => {
    const repo = candidate.model_name
    if (busyRepo) return
    setBusyRepo(repo)
    let variantId: string | undefined
    try {
      const card = await resolveCard(repo)
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
        setUnavailable((prev) => new Set(prev).add(repo))
        return
      }
      variantId = variant.model_id
      startedVariantByRepo.set(repo, variantId)
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
      }
      toast.error(t('hub:downloadFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setBusyRepo(null)
    }
  }

  const noModels = localEmpty ? (
    <StatusLine text={t('common:noModelsFoundFor', { searchValue: query })} />
  ) : null

  if (!eligible) return noModels
  if (status === 'searching') {
    return (
      <StatusLine
        text={t('common:modelPicker.searchingHuggingFace')}
        spinning
      />
    )
  }
  if (status === 'failed') {
    return <StatusLine text={t('common:modelPicker.huggingFaceUnavailable')} />
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
          key={candidate.model_name}
          candidate={candidate}
          busy={busyRepo === candidate.model_name}
          unavailable={unavailable.has(candidate.model_name)}
          onDownload={() => void download(candidate)}
        />
      ))}
    </div>
  )
}
