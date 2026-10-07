/* eslint-disable @typescript-eslint/no-explicit-any */
import { useVirtualizer } from '@tanstack/react-virtual'
import { createFileRoute, useNavigate } from '@tanstack/react-router'
import {
  useCallback,
  useEffect,
  useMemo,
  useRef,
  useState,
  type ReactNode,
} from 'react'
import { Loader } from 'lucide-react'
import HeaderPage from '@/containers/HeaderPage'
import { DecisionHub } from '@/containers/hub/DecisionHub'
import { EmbeddingHub } from '@/containers/hub/EmbeddingHub'
import { HubCategorySelect } from '@/containers/hub/HubCategorySelect'
import { HubFilters } from '@/containers/hub/HubFilters'
import { HubNoResults, HubSearchInput } from '@/containers/hub/HubSearch'
import { MediaHub } from '@/containers/hub/MediaHub'
import { ModelDetailPanel } from '@/containers/hub/ModelDetailPanel'
import { ModelListRow } from '@/containers/hub/ModelListRow'
import {
  ManagedHubBlocked,
  ManagedHubChecking,
} from '@/containers/hub/ManagedHubStatus'
import { RECOMMENDED_MODEL_FALLBACKS } from '@/constants/models'
import { route } from '@/constants/routes'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useHardware } from '@/hooks/useHardware'
import { useHuggingFaceFeed } from '@/hooks/useHuggingFaceFeed'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useModelSources } from '@/hooks/useModelSources'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useStaffPicks } from '@/hooks/useStaffPicks'
import { useManagedCurated } from '@/hooks/useManagedCurated'
import { useManagedHubStates } from '@/hooks/useManagedHubState'
import { usePrismFamilies, usePrismHubVisible } from '@/hooks/useModelSetup'
import { UNKNOWN_HUB_STATE } from '@/lib/managed-engine/hub-state'
import { hubKey, managedEngine } from '@/lib/managed-engines'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  applyHubFilters,
  hasLikeData,
  hubFormats,
  huggingFaceQueries,
  isUncensoredModel,
  modelDownloadSizeText,
  modelFitsBudget,
  normalizeHubFilters,
  parseHubEngine,
  readHubFilters,
  sortModels,
  writeHubFilters,
  type HubFilterState,
  type HubSortKey,
} from '@/lib/hub-filters'
import {
  collectInstalledModels,
  filterInstalledBySearch,
  withStaffPicks,
} from '@/lib/hub-installed'
import { isAnyDecisionHostSupported } from '@/lib/decision/platform'
import { isEmbeddingHostSupported } from '@/lib/embedding/engine'
import {
  HUB_CATEGORIES,
  isHubCategory,
  type HubCategory,
} from '@/lib/hub-media'
import { getMemoryBudgetBytes, type ModelFormat } from '@/lib/model-card'
import {
  hubListSources,
  managedBrowseRows,
  managedSearchRows,
  type ManagedPrefilterContext,
} from '@/lib/managed-engine/hub-feed'
import { extractModelName } from '@/lib/models'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { cn } from '@/lib/utils'
import { getModelSearchService } from '@/services/model-search'
import type { GpuFacts } from '@/services/managed-environment/types'
import { normalizeRepository } from '@/services/managed-models/models'
import {
  selectEnvironment,
  useManagedEnvironmentStore,
} from '@/stores/managed-environment-store'
import { useModelCatalogStore } from '@/stores/model-catalog-store'
import type { DiffusionModality } from '@/services/diffusion/types'
import type { CatalogModel, HuggingFaceFeedSort } from '@/services/models/types'
import type {
  StaffPick,
  StaffPickFormat,
} from '@/services/staff-picks-registry'
import { useShallow } from 'zustand/shallow'
import {
  getHubFormat,
  getHubSearchQuery,
  setHubFormat,
  setHubSearchQuery,
} from './hub-session'

type SearchParams = {
  repo?: string
  /** The format to open on (a provider page's "find a model"), applied once on entry. */
  engine?: ModelFormat
  q?: string
  /**
   * Repo id of the model shown in the right-hand detail panel; in the Images
   * and Video categories, the id of the catalog family; in Decision and
   * Embedding, the catalog id of the model.
   */
  model?: string
  /** Absent means Chat: every link into the Hub from a chat asks for one. */
  category?: HubCategory
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

/** One empty list for every render without a snapshot: a fresh `[]` would re-render forever. */
const NO_GPUS: GpuFacts[] = []

/** How many rows before the end of the list the next page is asked for. */
const FEED_PREFETCH_ROWS = 8

/**
 * A managed engine's prefilter can leave a whole page with nothing to show; after
 * this many such pages in a row the feed stops asking on its own, rather than
 * paging through every safetensors repository on Hugging Face.
 */
const MANAGED_EMPTY_PAGES_LIMIT = 3

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
    engine: parseHubEngine(search.engine),
    q: typeof search.q === 'string' ? search.q : undefined,
    model: typeof search.model === 'string' ? search.model : undefined,
    category: isHubCategory(search.category) ? search.category : undefined,
  }),
})

// Module-level cache (survives the Hub route remount on back-navigation) that
// preserves list scroll; `q` ties the offset to the search it belongs to.
const hubScrollCache: { q: string; offset: number } = { q: '', offset: 0 }

function HubContent() {
  const navigate = useNavigate()
  const { category: categorySearchParam } = Route.useSearch()
  const serviceHub = useServiceHub()
  const decisionApiSupported = serviceHub.decision().isSupported()
  const embeddingApiSupported = serviceHub.embedding().isSupported()
  const cpuArch = useHardware((s) => s.hardwareData.cpu.arch)
  // Image and video models need the local media engine, decision models a
  // TurboQuant or llama.cpp build for this machine, embedding models a
  // llama.cpp one; with none the Hub stays the chat catalog it always was,
  // switch and all.
  const mediaSupported = PlatformFeatures[PlatformFeature.MEDIA_GENERATION]
  const decisionSupported =
    PlatformFeatures[PlatformFeature.LOCAL_INFERENCE] &&
    decisionApiSupported &&
    isAnyDecisionHostSupported(cpuArch)
  const embeddingSupported =
    PlatformFeatures[PlatformFeature.LOCAL_INFERENCE] &&
    embeddingApiSupported &&
    isEmbeddingHostSupported(cpuArch)
  const categories = useMemo(
    () =>
      HUB_CATEGORIES.filter((c) =>
        c === 'decision'
          ? decisionSupported
          : c === 'embedding'
            ? embeddingSupported
            : c === 'chat' || mediaSupported
      ),
    [mediaSupported, decisionSupported, embeddingSupported]
  )
  const category: HubCategory =
    categorySearchParam && categories.includes(categorySearchParam)
      ? categorySearchParam
      : 'chat'

  const changeCategory = useCallback(
    (next: HubCategory) => {
      void navigate({
        to: route.hub.index,
        // The selection belongs to the category it was made in.
        search: (prev: SearchParams) => ({
          ...prev,
          category: next === 'chat' ? undefined : next,
          model: undefined,
          repo: undefined,
        }),
        replace: true,
      })
    },
    [navigate]
  )

  const categoryTabs =
    categories.length > 1 ? (
      <HubCategorySelect
        categories={categories}
        value={category}
        onChange={changeCategory}
      />
    ) : undefined

  if (category === 'chat') return <ChatHub categoryTabs={categoryTabs} />
  if (category === 'decision') {
    return <DecisionHubContent categoryTabs={categoryTabs} />
  }
  if (category === 'embedding') {
    return <EmbeddingHubContent categoryTabs={categoryTabs} />
  }
  return (
    <MediaHubContent
      key={category}
      modality={category}
      categoryTabs={categoryTabs}
    />
  )
}

function DecisionHubContent({ categoryTabs }: { categoryTabs?: ReactNode }) {
  const navigate = useNavigate()
  const { q: querySearchParam, model: modelSearchParam } = Route.useSearch()
  const [query, setQuery] = useState(querySearchParam ?? getHubSearchQuery())

  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next)
      setHubSearchQuery(next)
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({
          ...prev,
          q: next.trim() || undefined,
        }),
        replace: true,
      })
    },
    [navigate]
  )

  const selectModel = useCallback(
    (modelId: string, options?: { replace?: boolean }) => {
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({ ...prev, model: modelId }),
        replace: options?.replace ?? false,
      })
    },
    [navigate]
  )

  return (
    <DecisionHub
      categoryTabs={categoryTabs}
      query={query}
      onQueryChange={changeQuery}
      selectedModelId={modelSearchParam ?? null}
      onSelectModel={selectModel}
    />
  )
}

function EmbeddingHubContent({ categoryTabs }: { categoryTabs?: ReactNode }) {
  const navigate = useNavigate()
  const { q: querySearchParam, model: modelSearchParam } = Route.useSearch()
  const [query, setQuery] = useState(querySearchParam ?? getHubSearchQuery())

  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next)
      setHubSearchQuery(next)
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({
          ...prev,
          q: next.trim() || undefined,
        }),
        replace: true,
      })
    },
    [navigate]
  )

  const selectModel = useCallback(
    (modelId: string, options?: { replace?: boolean }) => {
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({ ...prev, model: modelId }),
        replace: options?.replace ?? false,
      })
    },
    [navigate]
  )

  return (
    <EmbeddingHub
      categoryTabs={categoryTabs}
      query={query}
      onQueryChange={changeQuery}
      selectedModelId={modelSearchParam ?? null}
      onSelectModel={selectModel}
    />
  )
}

function MediaHubContent({
  modality,
  categoryTabs,
}: {
  modality: DiffusionModality
  categoryTabs?: ReactNode
}) {
  const navigate = useNavigate()
  const { q: querySearchParam, model: modelSearchParam } = Route.useSearch()
  // One search box for every category: switching keeps what was typed.
  const [query, setQuery] = useState(querySearchParam ?? getHubSearchQuery())

  const changeQuery = useCallback(
    (next: string) => {
      setQuery(next)
      setHubSearchQuery(next)
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({
          ...prev,
          q: next.trim() || undefined,
        }),
        replace: true,
      })
    },
    [navigate]
  )

  const selectFamily = useCallback(
    (familyId: string, options?: { replace?: boolean }) => {
      void navigate({
        to: route.hub.index,
        search: (prev: SearchParams) => ({ ...prev, model: familyId }),
        replace: options?.replace ?? false,
      })
    },
    [navigate]
  )

  return (
    <MediaHub
      modality={modality}
      categoryTabs={categoryTabs}
      query={query}
      onQueryChange={changeQuery}
      selectedFamilyId={modelSearchParam ?? null}
      onSelectFamily={selectFamily}
    />
  )
}

function ChatHub({ categoryTabs }: { categoryTabs?: ReactNode }) {
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
    engine: engineSearchParam,
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
  // Every managed engine's state in the Hub (vLLM, TensorRT-LLM), each by its own plan.
  const managedHubs = useManagedHubStates()
  const visibleManaged = managedHubs
    .filter((entry) => entry.hub.visible)
    .map((entry) => entry.engine.id)
    .join(',')
  // Sort and toggles are saved; the format is GGUF on every launch and kept only for this one
  // (`hub-session.ts`). A format this machine does not offer (yet) reads as GGUF.
  const [storedFilters, setFilters] = useState<HubFilterState>(() => {
    const saved = readHubFilters()
    const format = getHubFormat()
    return format ? { ...saved, formats: [format] } : saved
  })
  const prismHubVisible = usePrismHubVisible()
  const availableFormats = useMemo(
    () =>
      hubFormats({
        mlx: IS_MACOS,
        managed: visibleManaged === '' ? [] : visibleManaged.split(','),
        prism: prismHubVisible,
      }),
    [visibleManaged, prismHubVisible]
  )
  const filters = useMemo(
    () => normalizeHubFilters(storedFilters, availableFormats),
    [storedFilters, availableFormats]
  )
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
    setHubFormat(next.formats[0] ?? null)
    writeHubFilters(next)
  }, [])

  // A link into the Hub that names a format (`?engine=`) opens on it, as if it
  // were picked from the filter, then leaves the URL: coming back to this page
  // must not undo a format chosen since. Kept as named: a format not offered
  // (yet — the provider list may still be loading) reads as GGUF meanwhile.
  useEffect(() => {
    if (!engineSearchParam) return
    updateFilters({ ...storedFilters, formats: [engineSearchParam] })
    void navigate({
      to: route.hub.index,
      search: (prev: SearchParams) => ({ ...prev, engine: undefined }),
      replace: true,
    })
    // Once per link: the filters it overrides are not a reason to apply it again.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [engineSearchParam])

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
  // A managed engine's format (vLLM, TensorRT-LLM) lists its descriptor's
  // curated models and a narrowed feed of any safetensors repository instead of
  // the picks and the catalog.
  const listSources = hubListSources(filters.formats[0] ?? 'gguf')
  const managedSelected = managedEngine(filters.formats[0])
  const managedFormat = managedSelected !== undefined
  const managedHub =
    managedHubs.find((entry) => entry.engine.id === managedSelected?.id)?.hub ??
    UNKNOWN_HUB_STATE
  // PrismML lists the Bonsai families of the core's model rules: no picks, no
  // catalog, no Hugging Face feed or search.
  const prismFormat = filters.formats[0] === 'atomic-prism'
  const prismFamilies = usePrismFamilies(prismFormat)

  // Under a managed engine's format the engine's state comes first: what blocks
  // it, or nothing at all until the core has answered. "Downloaded" lists what
  // is on disk whatever the format, so it is never replaced.
  const managedPanel: 'blocked' | 'checking' | null =
    !managedFormat || showOnlyDownloaded
      ? null
      : managedHub.state === 'blocked'
        ? 'blocked'
        : managedHub.state === 'unknown'
          ? 'checking'
          : null

  // Uncensored builds are a search of their own: the curated picks carry none,
  // so the filter opens the whole catalog plus Hugging Face even with no query.
  const isSearchMode =
    debouncedSearchValue.length > 0 || showOnlyDownloaded || filters.uncensored

  // Under the picks, the rest of Hugging Face in the order the sort dropdown
  // names — its own trending score by default — a page at a time.
  const feed = useHuggingFaceFeed(
    listSources.feedFormat,
    FEED_SORT_FOR[filters.sort],
    !isSearchMode && !managedPanel && !prismFormat
  )
  const uncensoredQueries = useMemo(
    () => huggingFaceQueries(debouncedSearchValue, true),
    [debouncedSearchValue]
  )
  const uncensoredFeed = useHuggingFaceFeed(
    listSources.feedFormat,
    FEED_SORT_FOR[filters.sort],
    filters.uncensored && !managedPanel && !prismFormat,
    uncensoredQueries[0] ?? ''
  )
  const abliteratedFeed = useHuggingFaceFeed(
    listSources.feedFormat,
    FEED_SORT_FOR[filters.sort],
    filters.uncensored &&
      !managedPanel &&
      !prismFormat &&
      uncensoredQueries.length > 1,
    uncensoredQueries[1] ?? ''
  )

  // The curated models of the engine's descriptor, and what narrows the feed:
  // its architectures and this machine's cards.
  const managedCurated = useManagedCurated(
    managedSelected?.id ?? '',
    managedFormat && !managedPanel ? managedHub.descriptorId : null
  )
  const managedGpus = useManagedEnvironmentStore(
    (state) => selectEnvironment(state)?.gpus ?? NO_GPUS
  )
  const managedContext = useMemo<ManagedPrefilterContext>(
    () => ({
      engineId: managedSelected?.id ?? '',
      supportedArchitectures: managedCurated.supportedArchitectures,
      gpus: managedGpus,
    }),
    [managedSelected?.id, managedCurated.supportedArchitectures, managedGpus]
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
  //
  // The staff picks claim their downloads too: onboarding offers picks the
  // catalog does not index, and the Hub must recognise the file it fetched.
  const installedCatalog = useMemo(
    () => withStaffPicks(sources, staffPickModels),
    [sources, staffPickModels]
  )
  const installedModels = useMemo(
    () =>
      showOnlyDownloaded
        ? collectInstalledModels(installedCatalog, providers)
        : [],
    [showOnlyDownloaded, installedCatalog, providers]
  )

  const installedResults = useMemo(
    () => filterInstalledBySearch(installedModels, debouncedSearchValue),
    [installedModels, debouncedSearchValue]
  )

  const catalogResults = useMemo(
    () =>
      listSources.catalog
        ? searchMatches.filter((model) => !isUnsupportedBaseGemmaMlx(model))
        : [],
    [listSources.catalog, searchMatches]
  )

  // A repository typed in full under a managed engine's format is shown as it is, whatever
  // the prefilter would say: the core's verdict in its card is the answer. A
  // bare word is not one — the lookup behind it finds GGUF repositories.
  const managedExactRepo = useMemo<CatalogModel | null>(() => {
    if (!managedFormat || !huggingFaceRepo) return null
    const typed = normalizeRepository(debouncedSearchValue).toLowerCase()
    if (huggingFaceRepo.model_name.toLowerCase() !== typed) return null
    return { ...huggingFaceRepo, is_mlx: false, is_managed: true }
  }, [managedFormat, huggingFaceRepo, debouncedSearchValue])

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
    // Behind a managed engine's panel nothing is listed, so nothing is asked;
    // PrismML lists its own families only.
    if (showOnlyDownloaded || managedPanel || prismFormat) {
      setHfCandidates((current) => (current.length > 0 ? [] : current))
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
    const cacheKey =
      `${listSources.feedFormat}\n${queries.join('\n')}`.toLowerCase()
    if (hfCandidatesFetchedForRef.current === cacheKey) return
    hfCandidatesFetchedForRef.current = cacheKey

    // A managed format's hits are narrowed by the prefilter afterwards, so it asks for more.
    const limit = managedFormat ? 30 : 10
    let cancelled = false
    let settled = false
    setHfSearching(true)
    Promise.all(
      queries.map((q) =>
        serviceHub
          .models()
          .searchHuggingFaceCandidates(
            q,
            huggingfaceToken,
            limit,
            managedFormat ? 'safetensors' : undefined
          )
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
    managedFormat,
    managedPanel,
    prismFormat,
    listSources.feedFormat,
  ])

  // ---- Unified list -----------------------------------------------------

  const listItems = useMemo<HubListItem[]>(() => {
    if (managedPanel) return []
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

    if (prismFormat) {
      // A search narrows the families by name; fit and Uncensored apply as
      // they do to any GGUF.
      const query = debouncedSearchValue.trim().toLowerCase()
      const matching = query
        ? prismFamilies.models.filter(
            (model) =>
              model.model_name.toLowerCase().includes(query) ||
              model.description.toLowerCase().includes(query)
          )
        : prismFamilies.models
      const filtered = applyHubFilters(
        matching,
        { ...filters, formats: ['gguf'] },
        { budgetBytes, applyFitFilter: true }
      )
      return filtered.map((model, index) => ({
        model,
        sectionLabel: index === 0 ? t('hub:prismCurated') : undefined,
      }))
    }

    if (!isSearchMode && managedFormat) {
      // The feed waits for the descriptor's architectures: narrowed only once
      // they arrive, its rows would vanish under the pointer.
      const rows = managedBrowseRows({
        curated: managedCurated.models,
        feed: managedCurated.loading ? [] : feed.models,
        context: managedContext,
      })
      return rows.map((row, index) => ({
        model: row.model,
        fromHuggingFace: row.section !== 'curated',
        sectionLabel:
          index === 0 || rows[index - 1].section !== row.section
            ? t(
                row.section === 'curated' && managedSelected
                  ? hubKey(managedSelected)('curated')
                  : 'hub:feedTitle'
              )
            : undefined,
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

    // A managed row keeps its listing entry: a card fetched for the same
    // repository as a GGUF or MLX row carries none of its architectures.
    const pagedUncensored = !filters.uncensored
      ? []
      : managedFormat
        ? [...uncensoredFeed.models, ...abliteratedFeed.models]
        : [...uncensoredFeed.models, ...abliteratedFeed.models].map(
            (model) => uncensoredFeed.details.get(model.model_name) ?? model
          )

    if (managedFormat) {
      const rows = managedSearchRows({
        exact: managedExactRepo,
        candidates: filters.uncensored ? pagedUncensored : hfCandidates,
        context: managedContext,
      })
      const exact = rows.filter((row) => row.section === 'exact').map((row) => row.model)
      // The memory-budget fit is a GGUF reading of system memory; managed
      // weights were already weighed against the cards by the prefilter.
      const found = applyHubFilters(
        rows.filter((row) => row.section !== 'exact').map((row) => row.model),
        filters,
        { applyFitFilter: false }
      )
      return [...exact, ...found].map((model, index) => ({
        model,
        fromHuggingFace: true,
        sectionLabel:
          filters.uncensored && index === 0 ? t('hub:uncensored') : undefined,
      }))
    }
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
    managedPanel,
    managedFormat,
    prismFormat,
    prismFamilies.models,
    debouncedSearchValue,
    managedCurated.models,
    managedCurated.loading,
    managedContext,
    managedExactRepo,
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

  // A repository typed in full under a managed format opens its card at once, to
  // show the core's verdict; once per repository, so a row picked afterwards
  // stays picked.
  const openedExactRef = useRef<string | null>(null)
  const exactRepoName = managedExactRepo?.model_name ?? null
  useEffect(() => {
    if (!exactRepoName || openedExactRef.current === exactRepoName) return
    openedExactRef.current = exactRepoName
    if (selectedRepo === exactRepoName) return
    void navigate({
      to: route.hub.index,
      search: (prev: SearchParams) => ({ ...prev, model: exactRepoName }),
      replace: true,
    })
  }, [exactRepoName, selectedRepo, navigate])

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

  const handleSearchChange = (next: string) => {
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
  // Feed entries and list rows when a managed format's page last arrived, and how
  // many pages in a row added no row (see MANAGED_EMPTY_PAGES_LIMIT).
  const managedFeedPages = useRef({ format: '', feed: 0, rows: 0, empty: 0 })
  const virtualItems = rowVirtualizer.getVirtualItems()
  const lastVisibleIndex = virtualItems[virtualItems.length - 1]?.index ?? -1
  const visibleFeedRepos = useMemo(
    () =>
      virtualItems
        .map((v) => listItems[v.index])
        .filter(
          (item): item is HubListItem =>
            !!item?.fromHuggingFace &&
            // A managed row needs no file sizes: its card asks the engines.
            !item.model.is_managed &&
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
    if (managedFormat) {
      // vLLM and TensorRT-LLM share one feed but not one prefilter: pages one emptied may fill
      // rows for the other, so the count starts over with the format.
      const format = managedSelected?.id ?? ''
      if (managedFeedPages.current.format !== format) {
        managedFeedPages.current = { format, feed: 0, rows: 0, empty: 0 }
      }
      const seen = managedFeedPages.current
      if (feed.models.length !== seen.feed) {
        seen.empty = listItems.length > seen.rows ? 0 : seen.empty + 1
        seen.feed = feed.models.length
        seen.rows = listItems.length
      }
    }
    if (
      lastVisibleIndex >= listItems.length - FEED_PREFETCH_ROWS &&
      !(managedFormat && managedFeedPages.current.empty >= MANAGED_EMPTY_PAGES_LIMIT)
    ) {
      feed.loadMore()
    }
    if (visibleFeedRepos) feed.ensureDetails(visibleFeedRepos.split('\n'))
  }, [
    isSearchMode,
    managedFormat,
    managedSelected?.id,
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
    if (model.is_managed) return
    if (modelDownloadSizeText(model) !== undefined) return
    feed.ensureDetails([model.model_name])
  }, [selectedItem, feed])

  const isEmpty = listItems.length === 0
  const uncensoredLoading =
    filters.uncensored &&
    (uncensoredFeed.loading || abliteratedFeed.loading)
  const managedLoading =
    managedFormat &&
    !isSearchMode &&
    (managedCurated.loading || feed.loading)
  const showSkeleton =
    isEmpty &&
    (prismFormat
      ? prismFamilies.loading
      : (loading && !isSearchMode) ||
        hfSearching ||
        uncensoredLoading ||
        managedLoading)

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
          <HubSearchInput
            value={searchValue}
            onChange={handleSearchChange}
            placeholder={t('hub:searchPlaceholder')}
            busy={isSearching || hfSearching}
          />
        </div>
      </HeaderPage>

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col border-r border-border">
        <div className="flex flex-col gap-2 border-b border-border p-3">
          {categoryTabs}
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
          {managedPanel === 'blocked' ? (
            managedSelected && (
              <ManagedHubBlocked engine={managedSelected} blockers={managedHub.blockers} />
            )
          ) : managedPanel === 'checking' ? (
            managedSelected && <ManagedHubChecking engine={managedSelected} />
          ) : showSkeleton ? (
            <div className="flex animate-pulse flex-col gap-2">
              {[...Array(6)].map((_, index) => (
                <div key={index} className="h-16 rounded-lg bg-muted" />
              ))}
            </div>
          ) : isEmpty ? (
            <HubNoResults
              message={
                !isSearchMode && filters.onlyFitting && !managedFormat
                  ? t('hub:noFittingPicks')
                  : t('hub:noModels')
              }
              onClearSearch={
                searchValue.length > 0
                  ? () => handleSearchChange('')
                  : undefined
              }
            />
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
                      managedFormat={
                        managedSelected ? (managedSelected.id as ModelFormat) : undefined
                      }
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
          managedFormat={managedSelected ? (managedSelected.id as ModelFormat) : undefined}
        />
      </div>
    </div>
  )
}
