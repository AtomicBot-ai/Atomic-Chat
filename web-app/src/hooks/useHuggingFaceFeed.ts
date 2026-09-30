import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { sanitizeModelId } from '@/lib/utils'
import type {
  CatalogModel,
  HuggingFaceFeedFormat,
  HuggingFaceFeedSort,
} from '@/services/models/types'

type FeedKey = string

type FeedState = {
  models: CatalogModel[]
  nextCursor: string | null
  /** `null` until the first page has been asked for. */
  loadedAt: number | null
}

const FEED_TTL_MS = 30 * 60 * 1000
/** How many detail fetches may be in flight at once for rows on screen. */
const DETAIL_CONCURRENCY = 2

// Module-level, like the Hub's scroll cache: leaving the Hub and coming back
// must not re-ask Hugging Face for pages the user already scrolled through.
const feeds = new Map<FeedKey, FeedState>()
const details = new Map<string, CatalogModel>()
const detailPending = new Set<string>()
const detailFailed = new Set<string>()

export function resetHuggingFaceFeedForTest(): void {
  feeds.clear()
  details.clear()
  detailPending.clear()
  detailFailed.clear()
}

export type HuggingFaceFeed = {
  /** Every page so far, in Hugging Face's order, lightweight entries. */
  models: CatalogModel[]
  /** Cards resolved for rows that came on screen, keyed by repo id. */
  details: ReadonlyMap<string, CatalogModel>
  /**
   * Bumps whenever `details` gains a card. The map keeps its identity, so a
   * consumer that memoizes on it must key on this instead.
   */
  detailsVersion: number
  hasMore: boolean
  loading: boolean
  error: string | null
  loadMore: () => void
  /** Rows on screen: fetch their file sizes, a couple at a time. */
  ensureDetails: (repoIds: readonly string[]) => void
}

/**
 * Hugging Face's own listing of one format in one order, page by page, with
 * the sizes of whatever is on screen fetched behind it.
 *
 * The list endpoint says which repos exist and how popular they are, but not
 * how big they are; that takes one request per repo. So a page is one request
 * for fifty rows, and sizes arrive only for rows the user has scrolled to,
 * two at a time, never twice — anonymous requests to Hugging Face are
 * rate-limited per IP, and a fast scroll through three hundred rows must not
 * turn into three hundred requests.
 */
export function useHuggingFaceFeed(
  format: HuggingFaceFeedFormat,
  sort: HuggingFaceFeedSort,
  enabled: boolean,
  search = ''
): HuggingFaceFeed {
  const serviceHub = useServiceHub()
  const huggingfaceToken = useGeneralSetting((s) => s.huggingfaceToken)
  const normalizedSearch = search.trim().toLowerCase()
  const key: FeedKey = `${format}:${sort}:${normalizedSearch}`
  const [version, bump] = useState(0)
  const rerender = useCallback(() => bump((n) => n + 1), [])
  const [loading, setLoading] = useState(false)
  const [error, setError] = useState<string | null>(null)
  // One entry per page request, `key|cursor`, so a sort switched mid-flight
  // neither blocks the new key nor lets the old request's end clear the
  // new one's guard and let the same cursor be asked for twice.
  const inFlight = useRef(new Set<string>())

  const loadPage = useCallback(
    async (cursor: string | null) => {
      const ticket = `${key}|${cursor ?? ''}`
      if (inFlight.current.has(ticket)) return
      inFlight.current.add(ticket)
      setLoading(true)
      setError(null)
      try {
        const page = await serviceHub.models().listHuggingFaceFeed({
          format,
          sort,
          search: normalizedSearch || undefined,
          cursor,
          hfToken: huggingfaceToken,
        })
        const previous = feeds.get(key)
        const seen = new Set(previous?.models.map((m) => m.model_name) ?? [])
        const fresh = page.models.filter((m) => {
          if (seen.has(m.model_name)) return false
          seen.add(m.model_name)
          return true
        })
        feeds.set(key, {
          models: [...(previous?.models ?? []), ...fresh],
          // A page that added nothing new ends the listing even if Hugging
          // Face still offers a cursor; otherwise a stuck cursor would loop.
          nextCursor: fresh.length > 0 ? page.nextCursor : null,
          loadedAt: Date.now(),
        })
      } catch (e) {
        setError(e instanceof Error ? e.message : String(e))
        if (!feeds.has(key)) {
          feeds.set(key, { models: [], nextCursor: null, loadedAt: Date.now() })
        }
      } finally {
        inFlight.current.delete(ticket)
        setLoading(inFlight.current.size > 0)
        rerender()
      }
    },
    [key, format, sort, normalizedSearch, huggingfaceToken, serviceHub, rerender]
  )

  // First page, once per key, or again after the cache has gone stale.
  useEffect(() => {
    if (!enabled) return
    const current = feeds.get(key)
    const stale =
      current?.loadedAt != null && Date.now() - current.loadedAt > FEED_TTL_MS
    if (current && !stale) return
    if (stale) feeds.delete(key)
    void loadPage(null)
  }, [enabled, key, loadPage])

  const state = feeds.get(key)

  const loadMore = useCallback(() => {
    const current = feeds.get(key)
    if (!enabled || !current?.nextCursor) return
    void loadPage(current.nextCursor)
  }, [enabled, key, loadPage])

  const ensureDetails = useCallback(
    (repoIds: readonly string[]) => {
      const wanted = repoIds.filter(
        (id) =>
          !details.has(id) && !detailPending.has(id) && !detailFailed.has(id)
      )
      if (wanted.length === 0) return
      const slots = Math.max(0, DETAIL_CONCURRENCY - detailPending.size)
      for (const repoId of wanted.slice(0, slots)) {
        detailPending.add(repoId)
        void serviceHub
          .models()
          .fetchHuggingFaceRepo(repoId, huggingfaceToken)
          .then((repo) => {
            if (!repo) {
              detailFailed.add(repoId)
              return
            }
            const catalog = serviceHub
              .models()
              .convertHfRepoToCatalogModel(repo)
            details.set(repoId, {
              ...catalog,
              model_name: repoId,
              quants: catalog.quants?.map((quant) => ({
                ...quant,
                model_id: sanitizeModelId(quant.model_id),
              })),
            })
          })
          .catch(() => {
            detailFailed.add(repoId)
          })
          .finally(() => {
            detailPending.delete(repoId)
            rerender()
          })
      }
    },
    [serviceHub, huggingfaceToken, rerender]
  )

  return useMemo(
    () => ({
      models: state?.models ?? [],
      details,
      detailsVersion: version,
      hasMore: !!state?.nextCursor,
      loading,
      error,
      loadMore,
      ensureDetails,
    }),
    [state, version, loading, error, loadMore, ensureDetails]
  )
}
