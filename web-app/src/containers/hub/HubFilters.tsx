import { useMemo, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { IconSearch } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuLabel,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHardware } from '@/hooks/useHardware'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  HUB_SORT_KEYS,
  LIKE_SORT_KEYS,
  type HubFilterState,
  type HubSortKey,
} from '@/lib/hub-filters'
import {
  CAPABILITIES,
  getMemoryBudgetBytes,
  type ModelFormat,
} from '@/lib/model-card'
import { cn } from '@/lib/utils'
import { useShallow } from 'zustand/shallow'

const SORT_LABEL_KEYS: Record<HubSortKey, string> = {
  'recommended': 'hub:sortRecommended',
  'downloads': 'hub:sortDownloads',
  'downloads-asc': 'hub:sortDownloadsAsc',
  'likes': 'hub:sortLikes',
  'likes-asc': 'hub:sortLikesAsc',
  'last-modified': 'hub:sortLastModified',
  'last-modified-asc': 'hub:sortLastModifiedAsc',
  'size-asc': 'hub:sortSizeAsc',
  'size-desc': 'hub:sortSizeDesc',
  'name-asc': 'hub:sortNameAsc',
  'name-desc': 'hub:sortNameDesc',
}

const FILTER_CHECKBOX_CLASS =
  'items-start whitespace-normal [&>span:first-child]:size-4 [&>span:first-child]:rounded-[5px] [&>span:first-child]:border [&>span:first-child]:border-input data-[state=checked]:[&>span:first-child]:border-primary data-[state=checked]:[&>span:first-child]:bg-primary data-[state=checked]:[&>span:first-child]:text-primary-foreground'

export type HubFiltersProps = {
  state: HubFilterState
  onChange: (next: HubFilterState) => void
  /** Hide the Likes options when the current data carries no like counts. */
  showLikesSort?: boolean
  showOnlyDownloaded?: boolean
  onShowOnlyDownloadedChange?: (checked: boolean) => void
  className?: string
}

export function HubFilters({
  state,
  onChange,
  showLikesSort = false,
  showOnlyDownloaded = false,
  onShowOnlyDownloadedChange,
  className,
}: HubFiltersProps) {
  const { t } = useTranslation()
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
  // be a filter that can only ever empty the list.
  const availableFormats: ModelFormat[] = IS_MACOS ? ['gguf', 'mlx'] : ['gguf']
  const sortKeys = HUB_SORT_KEYS.filter(
    (key) => showLikesSort || !LIKE_SORT_KEYS.includes(key)
  )
  // Without a memory reading the checkbox could not filter anything, and the
  // caption would read "Based on : ".
  const canFilterByFit = budgetBytes > 0

  const selectedFormat = state.formats[0] ?? 'gguf'

  // Search inside the menu: sorts, filters and capabilities by their label.
  const [query, setQuery] = useState('')
  const matches = (label: string) =>
    label.toLowerCase().includes(query.trim().toLowerCase())
  const shownSortKeys = sortKeys.filter((key) => matches(t(SORT_LABEL_KEYS[key])))
  const shownCapabilities = CAPABILITIES.filter((cap) => matches(cap.label))
  const showInstalled = matches(t('hub:installedOnDevice'))
  const showFit = canFilterByFit && matches(t('hub:fitFilterLabel'))
  const showUncensored = matches(t('hub:uncensored'))
  const anyFilter = showInstalled || showFit || showUncensored
  const nothingMatches =
    shownSortKeys.length === 0 && !anyFilter && shownCapabilities.length === 0

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {availableFormats.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label={t('hub:formats')}>
              {selectedFormat.toUpperCase()}
              <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start">
            <DropdownMenuRadioGroup
              value={selectedFormat}
              onValueChange={(format) =>
                onChange({ ...state, formats: [format as ModelFormat] })
              }
            >
              {availableFormats.map((format) => (
                <DropdownMenuRadioItem key={format} value={format}>
                  {format.toUpperCase()}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu onOpenChange={(open) => !open && setQuery('')}>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={t('hub:sortBy')}>
            {t(SORT_LABEL_KEYS[state.sort])}
            {state.capabilities.length > 0 && (
              <span
                className="ml-1.5 rounded-[5px] bg-secondary px-1.5 text-[10px] font-semibold"
                data-testid="hub-capability-count"
              >
                {state.capabilities.length}
              </span>
            )}
            <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        {/* Sorts, filters and capabilities make a tall menu: let it scroll
            within the window instead of running off the bottom. */}
        <DropdownMenuContent
          side="bottom"
          align="start"
          className="max-h-[var(--radix-dropdown-menu-content-available-height)] max-w-72 overflow-y-auto"
        >
          {/* Typing here must not jump to a menu item (Radix typeahead). */}
          <div className="px-2 pb-1 pt-1.5" onKeyDown={(event) => event.stopPropagation()}>
            <div className="flex items-center gap-1.5 rounded-md border border-input px-2">
              <IconSearch size={13} className="shrink-0 text-muted-foreground" />
              <input
                value={query}
                onChange={(event) => setQuery(event.target.value)}
                placeholder={t('hub:menuSearch')}
                aria-label={t('hub:menuSearch')}
                className="h-7 w-full bg-transparent text-xs text-foreground outline-none placeholder:text-muted-foreground"
              />
            </div>
          </div>
          {nothingMatches && (
            <p className="px-2 py-1.5 text-xs text-muted-foreground">{t('hub:menuNoMatches')}</p>
          )}
          {shownSortKeys.length > 0 && (
            <DropdownMenuLabel className="text-xs text-muted-foreground">
              {t('hub:sortBy')}
            </DropdownMenuLabel>
          )}
          {/* One sort at a time, each with a tick box (the user, 2026-09-15). */}
          {shownSortKeys.map((key) => (
            <DropdownMenuCheckboxItem
              key={key}
              checked={state.sort === key}
              onCheckedChange={() => onChange({ ...state, sort: key })}
              className={cn(FILTER_CHECKBOX_CLASS, 'my-0.5 items-center')}
            >
              {t(SORT_LABEL_KEYS[key])}
            </DropdownMenuCheckboxItem>
          ))}

          {shownSortKeys.length > 0 && anyFilter && <DropdownMenuSeparator />}
          {showInstalled && (
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
          )}

          {showFit && (
            <DropdownMenuCheckboxItem
              checked={state.onlyFitting}
              // Toggling a filter is not "picking one option and moving on":
              // keep the menu open so the effect on the list is visible.
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

          {showUncensored && (
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
          )}

          {/* The same neon badges the model page shows (the user, 2026-09-14).
              Ticking several keeps models that have all of them. */}
          {shownCapabilities.length > 0 && (shownSortKeys.length > 0 || anyFilter) && (
            <DropdownMenuSeparator />
          )}
          {shownCapabilities.length > 0 && (
          <DropdownMenuLabel
            className="text-xs text-muted-foreground"
            title={t('hub:capabilitiesFilterHint')}
          >
            {t('hub:capabilities')}
          </DropdownMenuLabel>
          )}
          {shownCapabilities.map((cap) => (
            <DropdownMenuCheckboxItem
              key={cap.key}
              checked={state.capabilities.includes(cap.key)}
              onSelect={(event) => event.preventDefault()}
              onCheckedChange={(checked) =>
                onChange({
                  ...state,
                  capabilities:
                    checked === true
                      ? [...state.capabilities.filter((k) => k !== cap.key), cap.key]
                      : state.capabilities.filter((k) => k !== cap.key),
                })
              }
              className={cn(FILTER_CHECKBOX_CLASS, 'items-center')}
            >
              <span
                className={cn(
                  'rounded-[5px] px-1.5 py-px text-[11px] font-semibold',
                  cap.className
                )}
              >
                {cap.label}
              </span>
            </DropdownMenuCheckboxItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
