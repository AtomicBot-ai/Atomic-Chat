import { useMemo } from 'react'
import { ArrowUpDown, SlidersHorizontal } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHardware } from '@/hooks/useHardware'
import { useHubEngines } from '@/hooks/useHubEngines'
import { useManagedHubStates } from '@/hooks/useManagedHubState'
import { useModelLikes } from '@/hooks/useModelLikes'
import { usePrismHubVisible } from '@/hooks/useModelSetup'
import { useFoundryLocalHubVisible } from '@/hooks/useFoundryLocalHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  HUB_FORMAT_LABELS,
  HUB_SORT_KEYS,
  hubFormats,
  type HubFilterState,
  type HubSortKey,
} from '@/lib/hub-filters'
import { hubEngine, hubEngineLabel } from '@/lib/hub-model-engines'
import { getMemoryBudgetBytes, type ModelFormat } from '@/lib/model-card'
import { cn } from '@/lib/utils'
import { useShallow } from 'zustand/shallow'

const SORT_LABEL_KEYS: Record<HubSortKey, string> = {
  'recommended': 'hub:sortRecommended',
  'likes': 'hub:sortLikes',
  'downloads': 'hub:sortDownloads',
  'last-modified': 'hub:sortLastModified',
}

const FILTER_CHECKBOX_CLASS =
  'items-start whitespace-normal [&>span:first-child]:size-4 [&>span:first-child]:rounded-[5px] [&>span:first-child]:border [&>span:first-child]:border-input data-[state=checked]:[&>span:first-child]:border-primary data-[state=checked]:[&>span:first-child]:bg-primary data-[state=checked]:[&>span:first-child]:text-primary-foreground'

export type HubFiltersProps = {
  state: HubFilterState
  onChange: (next: HubFilterState) => void
  /** Hide the Likes option when the current data carries no like counts. */
  showLikesSort?: boolean
  showOnlyDownloaded?: boolean
  onShowOnlyDownloadedChange?: (checked: boolean) => void
  className?: string
}

/**
 * The Text category's Filters and Sort, beside the search field. Filters holds
 * the engine and the format (one of each), and what to show only: liked,
 * uncensored, installed, or fitting models; the trigger counts the ones on.
 */
export function HubFilters({
  state,
  onChange,
  showLikesSort = false,
  showOnlyDownloaded = false,
  onShowOnlyDownloadedChange,
  className,
}: HubFiltersProps) {
  const { t } = useTranslation()
  const onlyLiked = useModelLikes((s) => s.onlyLiked)
  const setOnlyLiked = useModelLikes((s) => s.setOnlyLiked)
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

  // MLX only exists on Apple Silicon, so offering the toggle elsewhere would
  // be a filter that can only ever empty the list. Each managed engine and
  // PrismML follow their providers: no platform check of the Hub's own.
  const managedHubs = useManagedHubStates()
  const visibleManaged = managedHubs
    .filter((entry) => entry.hub.visible)
    .map((entry) => entry.engine.id)
  const prismVisible = usePrismHubVisible()
  const foundryLocalVisible = useFoundryLocalHubVisible()
  const availableFormats = hubFormats({
    mlx: IS_MACOS,
    managed: visibleManaged,
    prism: prismVisible,
    foundryLocal: foundryLocalVisible,
  })
  const engines = useHubEngines(availableFormats)
  const sortKeys = HUB_SORT_KEYS.filter(
    (key) => key !== 'likes' || showLikesSort
  )
  // Without a memory reading the checkbox could not filter anything.
  const canFilterByFit = budgetBytes > 0

  const selectedFormat = state.formats[0] ?? 'gguf'
  const activeCount = [
    Boolean(state.engine),
    onlyLiked,
    state.uncensored,
    showOnlyDownloaded,
    state.onlyFitting && canFilterByFit,
  ].filter(Boolean).length

  return (
    <div className={cn('flex shrink-0 items-center gap-2', className)}>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={t('hub:filters.label')}
            title={t('hub:filters.button')}
          >
            <SlidersHorizontal size={15} />
            <span className="hub-toolbar-label">{t('hub:filters.button')}</span>
            {activeCount > 0 && (
              <span className="rounded-full bg-primary/15 px-1.5 text-xs tabular-nums">
                {activeCount}
              </span>
            )}
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-[min(70vh,32rem)] w-max max-w-[calc(100vw-2rem)] min-w-64 overflow-y-auto"
        >
          {engines.length > 1 && (
            <>
              <DropdownMenuLabel>{t('hub:filters.engine')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={state.engine ?? 'all'}
                onValueChange={(id) => {
                  const engine = hubEngine(id)
                  onChange({
                    ...state,
                    engine: engine?.id,
                    formats: engine ? [engine.format] : state.formats,
                  })
                }}
              >
                <DropdownMenuRadioItem value="all">
                  {t('hub:filters.allEngines')}
                </DropdownMenuRadioItem>
                {engines.map((engine) => (
                  <DropdownMenuRadioItem key={engine.id} value={engine.id}>
                    {hubEngineLabel(engine.id)}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}
          {availableFormats.length > 1 && (
            <>
              <DropdownMenuLabel>{t('hub:filters.format')}</DropdownMenuLabel>
              <DropdownMenuRadioGroup
                value={selectedFormat}
                onValueChange={(format) =>
                  onChange({
                    ...state,
                    engine: undefined,
                    formats: [format as ModelFormat],
                  })
                }
              >
                {availableFormats.map((format) => (
                  <DropdownMenuRadioItem key={format} value={format}>
                    {HUB_FORMAT_LABELS[format]}
                  </DropdownMenuRadioItem>
                ))}
              </DropdownMenuRadioGroup>
              <DropdownMenuSeparator />
            </>
          )}
          <DropdownMenuLabel>{t('hub:filters.showOnly')}</DropdownMenuLabel>
          <DropdownMenuCheckboxItem
            checked={onlyLiked}
            // Toggling a filter is not "picking one option and moving on":
            // keep the menu open so the effect on the list is visible.
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => setOnlyLiked(checked === true)}
            className={FILTER_CHECKBOX_CLASS}
          >
            {t('hub:filters.liked')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={state.uncensored}
            title={t('hub:uncensoredHint')}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) =>
              onChange({ ...state, uncensored: checked === true })
            }
            className={FILTER_CHECKBOX_CLASS}
          >
            {t('hub:uncensored')}
          </DropdownMenuCheckboxItem>
          <DropdownMenuCheckboxItem
            checked={showOnlyDownloaded}
            onSelect={(event) => event.preventDefault()}
            onCheckedChange={(checked) => {
              const next = checked === true
              onShowOnlyDownloadedChange?.(next)
              if (next) {
                onChange({ ...state, onlyFitting: false })
              }
            }}
            className={FILTER_CHECKBOX_CLASS}
          >
            {t('hub:installedOnDevice')}
          </DropdownMenuCheckboxItem>
          {canFilterByFit && (
            <DropdownMenuCheckboxItem
              checked={state.onlyFitting}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) => {
                const next = checked === true
                onChange({ ...state, onlyFitting: next })
                if (next) {
                  onShowOnlyDownloadedChange?.(false)
                }
              }}
              className={FILTER_CHECKBOX_CLASS}
            >
              {t('hub:fitFilterLabel')}
            </DropdownMenuCheckboxItem>
          )}
          <DropdownMenuSeparator />
          <DropdownMenuItem
            disabled={activeCount === 0}
            onSelect={() => {
              setOnlyLiked(false)
              if (showOnlyDownloaded) onShowOnlyDownloadedChange?.(false)
              onChange({
                ...state,
                engine: undefined,
                uncensored: false,
                onlyFitting: false,
              })
            }}
          >
            {t('hub:filters.clear')}
          </DropdownMenuItem>
        </DropdownMenuContent>
      </DropdownMenu>

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={t('hub:sortBy')}
            title={t(SORT_LABEL_KEYS[state.sort])}
          >
            <ArrowUpDown size={15} />
            <span className="hub-toolbar-label">{t('hub:sort')}</span>
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="max-w-72">
          <DropdownMenuLabel>{t('hub:sortModels')}</DropdownMenuLabel>
          <DropdownMenuRadioGroup
            value={state.sort}
            onValueChange={(sort) =>
              onChange({ ...state, sort: sort as HubSortKey })
            }
          >
            {sortKeys.map((key) => (
              <DropdownMenuRadioItem key={key} value={key}>
                {t(SORT_LABEL_KEYS[key])}
              </DropdownMenuRadioItem>
            ))}
          </DropdownMenuRadioGroup>
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
