/* eslint-disable @typescript-eslint/no-explicit-any */
import { useVirtualizer } from '@tanstack/react-virtual'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ChangeEvent,
} from 'react'
import { IconSearch } from '@tabler/icons-react'
import { Loader } from 'lucide-react'
import HeaderPage from '@/containers/HeaderPage'
import { HubFilters } from '@/containers/hub/HubFilters'
import { ModelDetailPanel } from '@/containers/hub/ModelDetailPanel'
import { ModelListRow } from '@/containers/hub/ModelListRow'
import { RECOMMENDED_MODEL_FALLBACKS } from '@/constants/models'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useHuggingFaceFeed } from '@/hooks/useHuggingFaceFeed'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelSources } from '@/hooks/useModelSources'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useStaffPicks } from '@/hooks/useStaffPicks'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  applyHubFilters,
  hasLikeData,
  huggingFaceQueries,
  isUncensoredModel,
  modelDownloadSizeText,
  modelFitsBudget,
  readHubFilters,
  sortModels,
  writeHubFilters,
  type HubFilterState,
  type HubSortKey,
} from '@/lib/hub-filters'
import {
  collectInstalledModels,
  filterInstalledBySearch,
} from '@/lib/hub-installed'
import { getMemoryBudgetBytes } from '@/lib/model-card'
import { extractModelName } from '@/lib/models'
import { cn } from '@/lib/utils'
import { getModelSearchService } from '@/services/model-search'
import { useModelCatalogStore } from '@/stores/model-catalog-store'
import type { CatalogModel, HuggingFaceFeedSort } from '@/services/models/types'
import type {
  StaffPick,
  StaffPickFormat,
} from '@/services/staff-picks-registry'
import { useShallow } from 'zustand/shallow'
import { getHubSearchQuery, setHubSearchQuery } from './hub-session'

type SearchParams = {
  repo?: string
  engine?: 'mlx' | 'gguf'
  q?: string
  /** Repo id of the model shown in the right-hand detail panel. */
  model?: string
}

/** A row in the left column, plus the provenance the row needs to render. */
type HubListItem = {
  model: CatalogModel
  pick?: StaffPick
  fromHuggingFace?: boolean
  /** A heading painted above this row: the first row of a new section. */
  sectionLabel?: string
}

/** The Hub's sort dropdown, in Hugging Face's own vocabulary. */
const FEED_SORT_FOR: Record<HubSortKey, HuggingFaceFeedSort> = {
  'recommended': 'trending',
  'downloads': 'downloads',
  'likes': 'likes',
  'last-modified': 'lastModified',
}

/** How many rows before the end of the list the next page is asked for. */
const FEED_PREFETCH_ROWS = 8

// Base (non-instruction-tuned) Gemma 4 MLX builds (e.g.
// `mlx-community/gemma-4-12B-4bit`, converted from `google/gemma-4-12B`)
// ship no chat template and behave as raw text-completion models when used
// in chat — garbled output (stray markup / wrong-script tokens) that never
// stops. Only the `-it` instruction-tuned variants are usable. Hide the base
// builds from the MLX catalog/search so they can't be picked by mistake.
function isUnsupportedBaseGemmaMlx(model: CatalogModel) {
  const is_mlx = model.is_mlx ?? model.library_name === 'mlx'
  if (!is_mlx) return false
  const name = (
    extractModelName(model.model_name) ?? model.model_name
  ).toLowerCase()
  if (!/gemma[-_]?4/.test(name)) return false
  const isInstruct = /(^|[-_])it([-_]|$)/.test(name)
  const isDrafterArtifact =
    name.includes('assistant') ||
    name.includes('eagle3') ||
    name.includes('speculator') ||
    name.includes('dflash') ||
    name.includes('-mtp')
  return !isInstruct && !isDrafterArtifact
}

export const Route = createFileRoute(route.hub.index as any)({
  component: HubContent,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    repo: typeof search.repo === 'string' ? search.repo : undefined,
    engine:
      search.engine === 'mlx' || search.engine === 'gguf'
        ? search.engine
        : undefined,
    q: typeof search.q === 'string' ? search.q : undefined,
    model: typeof search.model === 'string' ? search.model : undefined,
  }),
})

// Module-level cache (survives the Hub route remount on back-navigation) that
// preserves list scroll; `q` ties the offset to the search it belongs to.
const hubScrollCache: { q: string; offset: number } = { q: '', offset: 0 }

function HubContent() {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const listScrollRef = useRef<HTMLDivElement>(null)
  const huggingfaceToken = useGeneralSetting((state) => state.huggingfaceToken)
  const scanLocalModelsEnabled = useGeneralSetting((s) => s.scanLocalModels)
  const {
    q: querySearchParam,
    model: modelSearchParam,
    repo: repoSearchParam,
  } = Route.useSearch()

  const catalogSnapshot = useModelCatalogStore((s) => s.catalog)
  const catalogIndexPayload = useModelCatalogStore((s) => s.index)

  const searchService = useMemo(() => {
    const svc = getModelSearchService()
    svc.setCatalog(catalogSnapshot)
    if (!svc.loadSnapshot(catalogIndexPayload)) {
      svc.rebuild()
    }
    return svc
  }, [catalogSnapshot, catalogIndexPayload])

  const { sources, fetchSources, loading } = useModelSources(
    useShallow((state) => ({
      sources: state.sources,
      fetchSources: state.fetchSources,
      loading: state.loading,
    }))
  )

  const providers = useModelProvider((state) => state.providers)
  const setProviders = useModelProvider((state) => state.setProviders)

  const { total_memory, gpus } = useHardware(
    useShallow((s) => ({
      total_memory: s.hardwareData.total_memory,
      gpus: s.hardwareData.gpus,
    }))
  )
  const budgetBytes = useMemo(
    () => getMemoryBudgetBytes({ total_memory, gpus }),
    [total_memory, gpus]
  )

  const [searchValue, setSearchValue] = useState(
    querySearchParam ?? getHubSearchQuery()
  )
  const [debouncedSearchValue, setDebouncedSearchValue] = useState(searchValue)
  const [filters, setFilters] = useState<HubFilterState>(() => readHubFilters())
  const [showOnlyDownloaded, setShowOnlyDownloaded] = useState(false)
  const [isSearching, setIsSearching] = useState(false)
  const [hfSearching, setHfSearching] = useState(false)
  const [huggingFaceRepo, setHuggingFaceRepo] = useState<CatalogModel | null>(
    null
  )
  const [hfCandidates, setHfCandidates] = useState<CatalogModel[]>([])
  const [deepLinkedModel, setDeepLinkedModel] = useState<CatalogModel | null>(
    null
  )
  const hfCandidatesFetchedForRef = useRef<string>('')
  const exactRepoTimeoutRef = useRef<ReturnType<typeof setTimeout> | null>(null)

  const updateFilters = useCallback((next: HubFilterState) => {
    setFilters(next)
    writeHubFilters(next)
  }, [])

  // MiniSearch resolves a query against ~3k models in single-digit ms, so a
  // long debounce only leaves the previous query's results on screen — read
  // as a flicker. Clearing the field bypasses the debounce entirely.
  useEffect(() => {
    if (searchValue === '') {
      setDebouncedSearchValue('')
      return
    }
    const handler = setTimeout(() => setDebouncedSearchValue(searchValue), 80)
    return () => clearTimeout(handler)
  }, [searchValue])

  useEffect(() => {
    void fetchSources()
  }, [fetchSources])

  // Re-list engines on Hub enter / window focus so a deleted external file
  // shows its broken badge.
  useEffect(() => {
    if (!scanLocalModelsEnabled) return
    let cancelled = false
    const refresh = () => {
      serviceHub
        .providers()
        .getProviders()
        .then((fetched) => {
          if (!cancelled) setProviders(fetched)
        })
        .catch(() => {})
    }
    refresh()
    window.addEventListener('focus', refresh)
    return () => {
      cancelled = true
      window.removeEventListener('focus', refresh)
    }
  }, [scanLocalModelsEnabled, serviceHub, setProviders])

  // The curated list carries a GGUF and an MLX entry per model. Showing both
  // at once would list every model twice, so MLX picks surface only once the
  // user narrows the format filter to MLX alone.
  const picksFormat: StaffPickFormat =
    filters.formats.length === 1 && filters.formats[0] === 'mlx'
      ? 'mlx'
      : 'gguf'
  const staffPickItems = useStaffPicks(sources, picksFormat)

  // Uncensored builds are a search of their own: the curated picks carry none,
  // so the filter opens the whole catalog plus Hugging Face even with no query.
  const isSearchMode =
    debouncedSearchValue.length > 0 || showOnlyDownloaded || filters.uncensored

  // Under the picks, the rest of Hugging Face in the order the sort dropdown
  // names — its own trending score by default — a page at a time.
  const feed = useHuggingFaceFeed(
    picksFormat,
    FEED_SORT_FOR[filters.sort],
    !isSearchMode
  )
  const uncensoredQueries = useMemo(
    () => huggingFaceQueries(debouncedSearchValue, true),
    [debouncedSearchValue]
  )
  const uncensoredFeed = useHuggingFaceFeed(
    picksFormat,
    FEED_SORT_FOR[filters.sort],
    filters.uncensored,
    uncensoredQueries[0] ?? ''
  )
  const abliteratedFeed = useHuggingFaceFeed(
    picksFormat,
    FEED_SORT_FOR[filters.sort],
    filters.uncensored && uncensoredQueries.length > 1,
    uncensoredQueries[1] ?? ''
  )

  // ---- Staff picks mode -------------------------------------------------

  const staffPickModels = useMemo(
    () =>
      staffPickItems
        .filter((item) => item.model !== null)
        .map((item) => item.model as CatalogModel),
    [staffPickItems]
  )

  const pickByRepo = useMemo(() => {
    const map = new Map<string, StaffPick>()
    for (const item of staffPickItems) {
      if (item.model) map.set(item.model.model_name, item.pick)
    }
    return map
  }, [staffPickItems])

  // ---- Search mode ------------------------------------------------------

  const searchMatches = useMemo(() => {
    if (debouncedSearchValue.length === 0) return sources
    const scored = searchService.search(debouncedSearchValue, { limit: 500 })
    if (scored.length === 0) return []
    const bySource = new Map(sources.map((m) => [m.model_name, m]))
    const ordered: CatalogModel[] = []
    const seen = new Set<string>()
    for (const hit of scored) {
      if (seen.has(hit.model_name)) continue
      const original = bySource.get(hit.model_name)
      if (!original) continue
      seen.add(hit.model_name)
      ordered.push(original)
    }
    return ordered
  }, [debouncedSearchValue, searchService, sources])

  // Every locally installed model, not the catalog narrowed down to the ones it
  // happens to carry: a model imported by hand or found by the local scan has
  // no catalog entry to filter to.
  //
  // Reading `providers` reactively (rather than via `getState()`) is what makes
  // a downloaded/deleted model appear or vanish immediately (ATO-180).
  const installedModels = useMemo(
    () =>
      showOnlyDownloaded ? collectInstalledModels(sources, providers) : [],
    [showOnlyDownloaded, sources, providers]
  )

  const installedResults = useMemo(
    () => filterInstalledBySearch(installedModels, debouncedSearchValue),
    [installedModels, debouncedSearchValue]
  )

  const catalogResults = useMemo(
    () => searchMatches.filter((model) => !isUnsupportedBaseGemmaMlx(model)),
    [searchMatches]
  )

  // Exact-repo lookup: the user pasted a full `owner/name`.
  const fetchExactRepo = useCallback(
    (rawValue: string) => {
      const normalized = rawValue.trim()
      if (normalized.length < 3) return

      setIsSearching(true)
      if (exactRepoTimeoutRef.current) {
        clearTimeout(exactRepoTimeoutRef.current)
      }
      exactRepoTimeoutRef.current = setTimeout(async () => {
        try {
          const repoInfo = await serviceHub
            .models()
            .fetchHuggingFaceRepo(normalized, huggingfaceToken)
          if (repoInfo) {
            setHuggingFaceRepo(
              serviceHub.models().convertHfRepoToCatalogModel(repoInfo)
            )
          }
        } catch (error) {
          console.error('Error fetching repository info:', error)
        } finally {
          setIsSearching(false)
        }
      }, 500)
    },
    [serviceHub, huggingfaceToken]
  )

  // Long-tail Hugging Face fallback (Path B): fan out to HF's public search
  // when the curated catalog returns sparse hits for a non-trivial query.
  // Uncensored has cursor-based feeds of its own above; keeping it out of this
  // one-shot path removes the old 20-results-per-term ceiling.
  useEffect(() => {
    if (showOnlyDownloaded) {
      setHfCandidates([])
      hfCandidatesFetchedForRef.current = ''
      return
    }
    if (filters.uncensored) {
      setHfCandidates((current) => (current.length > 0 ? [] : current))
      hfCandidatesFetchedForRef.current = ''
      setHfSearching(false)
      return
    }
    const query = debouncedSearchValue.trim()
    if (query.length < 3 || catalogResults.length >= 5) {
      if (catalogResults.length >= 5) setHfCandidates([])
      return
    }
    const queries = huggingFaceQueries(query, false)
    const cacheKey = queries.join('\n').toLowerCase()
    if (hfCandidatesFetchedForRef.current === cacheKey) return
    hfCandidatesFetchedForRef.current = cacheKey

    const limit = 10
    let cancelled = false
    let settled = false
    setHfSearching(true)
    Promise.all(
      queries.map((q) =>
        serviceHub
          .models()
          .searchHuggingFaceCandidates(q, huggingfaceToken, limit)
      )
    )
      .then((batches) => {
        if (cancelled) return
        const seen = new Set(catalogResults.map((m) => m.model_name))
        if (huggingFaceRepo) seen.add(huggingFaceRepo.model_name)
        const merged: CatalogModel[] = []
        for (const candidate of batches.flat()) {
          if (!candidate.model_name || seen.has(candidate.model_name)) continue
          seen.add(candidate.model_name)
          merged.push(candidate)
        }
        setHfCandidates(merged)
      })
      .catch(() => {
        if (!cancelled) setHfCandidates([])
      })
      .finally(() => {
        settled = true
        if (!cancelled) setHfSearching(false)
      })
    return () => {
      cancelled = true
      setHfSearching(false)
      // A run superseded mid-flight (the catalog finished loading, say) drops
      // its answer, so let the next run ask again instead of hitting the cache.
      if (!settled) hfCandidatesFetchedForRef.current = ''
    }
  }, [
    debouncedSearchValue,
    catalogResults,
    showOnlyDownloaded,
    filters.uncensored,
    serviceHub,
    huggingfaceToken,
    huggingFaceRepo,
  ])

  // ---- Unified list -----------------------------------------------------

  const listItems = useMemo<HubListItem[]>(() => {
    if (showOnlyDownloaded) {
      // The format and fit filters describe what to look for in the catalog;
      // applied here they would hide models the user already has on disk.
      // Uncensored is about the model itself, so it still narrows the list.
      const installed = filters.uncensored
        ? installedResults.filter(isUncensoredModel)
        : installedResults
      return sortModels(installed, filters.sort).map((model) => ({
        model,
        pick: pickByRepo.get(model.model_name),
      }))
    }

    if (!isSearchMode) {
      const filtered = applyHubFilters(staffPickModels, filters, {
        budgetBytes,
        applyFitFilter: true,
      })
      const picks: HubListItem[] = filtered.map((model, index) => ({
        model,
        pick: pickByRepo.get(model.model_name),
        sectionLabel: index === 0 ? t('hub:staffPicks') : undefined,
      }))

      // The feed is already in Hugging Face's order for this sort, so it is
      // appended as a section rather than re-sorted into the picks. A repo
      // the catalog knows is shown from the catalog, sizes included; one the
      // user has scrolled to shows the card fetched for it; the rest stay
      // lightweight until they come on screen.
      const taken = new Set(
        staffPickModels.map((m) => m.model_name.toLowerCase())
      )
      const bySource = new Map(
        sources.map((m) => [m.model_name.toLowerCase(), m])
      )
      const feedRows: HubListItem[] = []
      for (const entry of feed.models) {
        const key = entry.model_name.toLowerCase()
        if (taken.has(key)) continue
        taken.add(key)
        const model =
          bySource.get(key) ?? feed.details.get(entry.model_name) ?? entry
        if (isUnsupportedBaseGemmaMlx(model)) continue
        // A size the row does not know yet cannot fail the fit filter.
        if (
          filters.onlyFitting &&
          budgetBytes > 0 &&
          modelDownloadSizeText(model) !== undefined &&
          !modelFitsBudget(model, budgetBytes)
        ) {
          continue
        }
        feedRows.push({
          model,
          fromHuggingFace: true,
          sectionLabel: feedRows.length === 0 ? t('hub:feedTitle') : undefined,
        })
      }
      return [...picks, ...feedRows]
    }

    const seen = new Set(catalogResults.map((m) => m.model_name))
    const head: CatalogModel[] =
      huggingFaceRepo &&
      !seen.has(huggingFaceRepo.model_name) &&
      catalogResults.length < 5
        ? [huggingFaceRepo]
        : []
    for (const model of head) seen.add(model.model_name)

    const pagedUncensored = filters.uncensored
      ? [...uncensoredFeed.models, ...abliteratedFeed.models].map(
          (model) => uncensoredFeed.details.get(model.model_name) ?? model
        )
      : []
    // A search hit carries no file list, so the detail panel has nothing to
    // offer for download until the card fetched for the selected row replaces
    // it — the same swap the feed and the uncensored listing make.
    const tailSource = filters.uncensored
      ? pagedUncensored
      : hfCandidates.map((model) => feed.details.get(model.model_name) ?? model)
    const tail = tailSource.filter((candidate) => {
      if (
        seen.has(candidate.model_name) ||
        isUnsupportedBaseGemmaMlx(candidate)
      ) {
        return false
      }
      seen.add(candidate.model_name)
      return true
    })

    const hfNames = new Set([
      ...head.map((m) => m.model_name),
      ...tail.map((m) => m.model_name),
    ])

    const filtered = applyHubFilters(
      [...head, ...catalogResults, ...tail],
      filters,
      { budgetBytes, applyFitFilter: true }
    )

    return filtered.map((model, index) => ({
      model,
      fromHuggingFace: hfNames.has(model.model_name),
      sectionLabel:
        filters.uncensored && index === 0 ? t('hub:uncensored') : undefined,
    }))
  }, [
    isSearchMode,
    showOnlyDownloaded,
    installedResults,
    staffPickModels,
    pickByRepo,
    catalogResults,
    huggingFaceRepo,
    hfCandidates,
    uncensoredFeed.models,
    uncensoredFeed.details,
    uncensoredFeed.detailsVersion,
    abliteratedFeed.models,
    abliteratedFeed.detailsVersion,
    filters,
    budgetBytes,
    sources,
    feed.models,
    feed.details,
    // The details map keeps its identity; its version is what changes.
    feed.detailsVersion,
    t,
  ])

  const showLikesSort = useMemo(
    () => hasLikeData(listItems.map((item) => item.model)),
    [listItems]
  )

  // ---- Selection --------------------------------------------------------

  const selectedRepo = modelSearchParam ?? null

  const selectedItem = useMemo(() => {
    if (!selectedRepo) return null
    const fromList = listItems.find(
      (item) => item.model.model_name === selectedRepo
    )
    if (fromList) return fromList
    const fromSources = sources.find((m) => m.model_name === selectedRepo)
    if (fromSources) {
      return { model: fromSources, pick: pickByRepo.get(selectedRepo) }
    }
    if (deepLinkedModel?.model_name === selectedRepo) {
      return { model: deepLinkedModel, pick: pickByRepo.get(selectedRepo) }
    }
    return null
  }, [selectedRepo, listItems, sources, deepLinkedModel, pickByRepo])

  // Deep link into a repo the catalog does not carry: resolve it from HF once.
  useEffect(() => {
    if (!selectedRepo || selectedItem) return
    const fallback =
      RECOMMENDED_MODEL_FALLBACKS[repoSearchParam ?? selectedRepo]
    if (fallback) {
      setDeepLinkedModel(fallback)
      return
    }
    let cancelled = false
    serviceHub
      .models()
      .fetchHuggingFaceRepo(repoSearchParam ?? selectedRepo, huggingfaceToken)
      .then((repo) => {
        if (cancelled || !repo) return
        setDeepLinkedModel(
          serviceHub.models().convertHfRepoToCatalogModel(repo)
        )
      })
      .catch((error) => {
        console.error('Failed to resolve deep-linked model:', error)
      })
    return () => {
      cancelled = true
    }
  }, [
    selectedRepo,
    selectedItem,
    repoSearchParam,
    serviceHub,
    huggingfaceToken,
  ])

  const selectModel = useCallback(
    (repoId: string) => {
      const el = listScrollRef.current
      hubScrollCache.q = searchValue.trim()
      hubScrollCache.offset = el ? el.scrollTop : 0
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({ ...prev, model: repoId }),
        replace: false,
      })
    },
    [navigate, searchValue]
  )

  // Open on a populated panel rather than on an empty right-hand column: with
  // nothing selected the widest part of the page carries no information. Only
  // fires while the URL names no model, so it never overrides a deep link and
  // never fights the user's own selection.
  useEffect(() => {
    if (selectedRepo || listItems.length === 0) return
    void navigate({
      to: route.hub.index,
      search: (prev: SearchParams) => ({
        ...prev,
        model: listItems[0].model.model_name,
      }),
      replace: true,
    })
  }, [selectedRepo, listItems, navigate])

  // ---- URL sync ---------------------------------------------------------

  useEffect(() => {
    const current = querySearchParam ?? ''
    const next = debouncedSearchValue.trim()
    setHubSearchQuery(next)
    if (next === current) return
    void navigate({
      to: route.hub.index,
      search: (prev: SearchParams) => ({ ...prev, q: next || undefined }),
      replace: true,
    })
  }, [debouncedSearchValue, querySearchParam, navigate])

  const handleSearchChange = (event: ChangeEvent<HTMLInputElement>) => {
    const next = event.target.value
    setIsSearching(false)
    setSearchValue(next)
    setHubSearchQuery(next)
    // Only drop the "found outside catalog" card when the new query can not
    // yield a result anyway (matches the `< 3` early return in
    // `fetchExactRepo`); clearing it on every keystroke read as a flicker.
    if (next.trim().length < 3) {
      setHuggingFaceRepo(null)
    }
    if (!showOnlyDownloaded) {
      fetchExactRepo(next)
    }
  }

  // ---- Virtual list -----------------------------------------------------

  const rowVirtualizer = useVirtualizer({
    count: listItems.length,
    getScrollElement: () => listScrollRef.current,
    estimateSize: useCallback(() => 72, []),
    overscan: 8,
    measureElement: (el: HTMLElement) => el.getBoundingClientRect().height,
  })

  // Restore the saved scroll offset once the list is populated after
  // back-navigation; the container can still be growing (clamping an early
  // `scrollTop`), so re-apply across a few frames until it sticks.
  const didRestoreScroll = useRef(false)
  useEffect(() => {
    if (didRestoreScroll.current) return
    if (listItems.length === 0) return

    const target = hubScrollCache.offset
    const matchesQuery = hubScrollCache.q === (querySearchParam ?? '')
    if (target <= 0 || !matchesQuery) {
      didRestoreScroll.current = true
      return
    }

    didRestoreScroll.current = true
    hubScrollCache.offset = 0
    let attempts = 0
    const apply = () => {
      const el = listScrollRef.current
      if (!el) return
      el.scrollTop = target
      attempts += 1
      if (Math.abs(el.scrollTop - target) > 2 && attempts < 12) {
        requestAnimationFrame(apply)
      }
    }
    requestAnimationFrame(apply)
  }, [listItems.length, querySearchParam])

  // The next page is asked for a few rows before the end, and the rows on
  // screen that still lack a size get their card fetched — both from what the
  // virtualizer is actually painting, so a fast scroll costs what it shows.
  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems[virtualItems.length - 1]?.index ?? -1
  const visibleFeedRepos = useMemo(
    () =>
      virtualItems
        .map((v) => listItems[v.index])
        .filter(
          (item): item is HubListItem =>
            !!item?.fromHuggingFace &&
            modelDownloadSizeText(item.model) === undefined
        )
        .map((item) => item.model.model_name)
        .join('\n'),
    // The virtual window is a new array every render; its contents are what
    // matter, and `lastVisibleIndex` moves whenever they do.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [lastVisibleIndex, listItems]
  )
  useEffect(() => {
    if (listItems.length === 0) return
    if (filters.uncensored) {
      if (lastVisibleIndex >= listItems.length - FEED_PREFETCH_ROWS) {
        uncensoredFeed.loadMore()
        abliteratedFeed.loadMore()
      }
      if (visibleFeedRepos) {
        const repos = visibleFeedRepos.split('\n')
        uncensoredFeed.ensureDetails(repos)
        abliteratedFeed.ensureDetails(repos)
      }
      return
    }
    if (isSearchMode) return
    if (lastVisibleIndex >= listItems.length - FEED_PREFETCH_ROWS) {
      feed.loadMore()
    }
    if (visibleFeedRepos) feed.ensureDetails(visibleFeedRepos.split('\n'))
  }, [
    isSearchMode,
    filters.uncensored,
    listItems.length,
    lastVisibleIndex,
    visibleFeedRepos,
    feed,
    uncensoredFeed,
    abliteratedFeed,
  ])

  // A selected feed row needs its card whether or not it is still on screen:
  // the detail panel's download options come from it.
  useEffect(() => {
    const model = selectedItem?.model
    if (!model || !('fromHuggingFace' in selectedItem)) return
    if (!selectedItem.fromHuggingFace) return
    if (modelDownloadSizeText(model) !== undefined) return
    feed.ensureDetails([model.model_name])
  }, [selectedItem, feed])

  const isEmpty = listItems.length === 0
  const uncensoredLoading =
    filters.uncensored &&
    (uncensoredFeed.loading || abliteratedFeed.loading)
  const showSkeleton =
    isEmpty && ((loading && !isSearchMode) || hfSearching || uncensoredLoading)

  return (
    <div className="grid h-svh w-full grid-cols-[minmax(320px,420px)_1fr] grid-rows-[auto_minmax(0,1fr)]">
      <HeaderPage>
        <div
          className={cn(
            'relative z-20 flex h-10 w-full items-center gap-2 py-3 pr-3',
            !IS_MACOS && !IS_WINDOWS && 'pr-30'
          )}
          {...(IS_WINDOWS || IS_MACOS
            ? { 'data-tauri-drag-region': true }
            : {})}
        >
          {isSearching || hfSearching ? (
            <Loader className="size-4 shrink-0 animate-spin text-muted-foreground" />
          ) : (
            <IconSearch className="shrink-0 text-muted-foreground" size={14} />
          )}
          <input
            placeholder={t('hub:searchPlaceholder')}
            value={searchValue}
            onChange={handleSearchChange}
            autoComplete="off"
            aria-label={t('hub:searchPlaceholder')}
            className="hub-models-search-input w-full min-w-0 flex-1 bg-transparent bg-clip-padding text-foreground shadow-none transition-none animate-none placeholder:text-muted-foreground focus:outline-none focus-visible:ring-0 focus-visible:ring-offset-0"
          />
        </div>
      </HeaderPage>

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col border-r border-border">
        <div className="flex flex-col gap-2 border-b border-border p-3">
          <HubFilters
            state={filters}
            onChange={updateFilters}
            showLikesSort={showLikesSort}
            showOnlyDownloaded={showOnlyDownloaded}
            onShowOnlyDownloadedChange={(checked) => {
              setShowOnlyDownloaded(checked)
              if (checked) {
                setHuggingFaceRepo(null)
              } else {
                fetchExactRepo(searchValue)
              }
            }}
          />
        </div>

        <div ref={listScrollRef} className="min-h-0 flex-1 overflow-y-auto p-2">
          {showSkeleton ? (
            <div className="flex animate-pulse flex-col gap-2">
              {[...Array(6)].map((_, index) => (
                <div key={index} className="h-16 rounded-lg bg-muted" />
              ))}
            </div>
          ) : isEmpty ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {!isSearchMode && filters.onlyFitting
                ? t('hub:noFittingPicks')
                : t('hub:noModels')}
            </p>
          ) : (
            <div
              style={{
                height: `${rowVirtualizer.getTotalSize()}px`,
                width: '100%',
                position: 'relative',
              }}
            >
              {rowVirtualizer.getVirtualItems().map((virtualItem) => {
                const item = listItems[virtualItem.index]
                return (
                  <div
                    key={virtualItem.key}
                    data-index={virtualItem.index}
                    ref={rowVirtualizer.measureElement}
                    style={{
                      position: 'absolute',
                      top: 0,
                      left: 0,
                      width: '100%',
                      transform: `translateY(${virtualItem.start}px)`,
                      paddingBottom: 4,
                    }}
                  >
                    {item.sectionLabel && (
                      <h2 className="px-2 pb-2 pt-4 text-base font-semibold text-foreground">
                        {item.sectionLabel}
                      </h2>
                    )}
                    <ModelListRow
                      model={item.model}
                      pick={item.pick}
                      fromHuggingFace={item.fromHuggingFace}
                      selected={item.model.model_name === selectedRepo}
                      onSelect={() => selectModel(item.model.model_name)}
                    />
                  </div>
                )
              })}
            </div>
          )}
          {!isSearchMode && !isEmpty && feed.loading && (
            <p
              className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
              role="status"
            >
              <Loader className="size-3 animate-spin" />
              {t('hub:feedLoading')}
            </p>
          )}
          {filters.uncensored && !isEmpty && uncensoredLoading && (
            <p
              className="flex items-center justify-center gap-2 py-3 text-xs text-muted-foreground"
              role="status"
            >
              <Loader className="size-3 animate-spin" />
              {t('hub:feedLoading')}
            </p>
          )}
          {!isSearchMode && !isEmpty && !feed.loading && feed.error && (
            <p className="py-3 text-center text-xs text-muted-foreground">
              {t('hub:feedFailed')}
            </p>
          )}
        </div>
      </div>

      <div className="col-start-2 row-span-2 row-start-1 min-h-0 min-w-0 overflow-y-auto">
        <ModelDetailPanel
          model={selectedItem?.model ?? null}
          pick={selectedItem?.pick}
        />
      </div>
    </div>
  )
}
