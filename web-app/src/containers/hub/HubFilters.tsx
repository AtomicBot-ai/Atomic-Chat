import { useMemo } from 'react'
import { Check, ChevronsUpDown } from 'lucide-react'
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
import { usePrismHubVisible } from '@/hooks/useModelSetup'
import { useTensorrtHubState } from '@/hooks/useTensorrtHubState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  HUB_FORMAT_LABELS,
  HUB_SORT_KEYS,
  hubFormats,
  type HubFilterState,
  type HubSortKey,
} from '@/lib/hub-filters'
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

// Dropdown triggers give way to Uncensored instead of pushing it out. The sort
// label goes first: "TensorRT-LLM" is the one that tells you what you browse.
const FORMAT_TRIGGER_CLASS = 'max-w-[40%] overflow-hidden'
const SORT_TRIGGER_CLASS = 'min-w-0 shrink overflow-hidden'

export type HubFiltersProps = {
  state: HubFilterState
  onChange: (next: HubFilterState) => void
  /** Hide the Likes option when the current data carries no like counts. */
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
  // be a filter that can only ever empty the list. TensorRT-LLM and PrismML
  // follow their providers: no platform check of the Hub's own.
  const tensorrtVisible = useTensorrtHubState().visible
  const prismVisible = usePrismHubVisible()
  const availableFormats = hubFormats({
    mlx: IS_MACOS,
    tensorrt: tensorrtVisible,
    prism: prismVisible,
  })
  const sortKeys = HUB_SORT_KEYS.filter(
    (key) => key !== 'likes' || showLikesSort
  )
  // Without a memory reading the checkbox could not filter anything, and the
  // caption would read "Based on : ".
  const canFilterByFit = budgetBytes > 0

  const selectedFormat = state.formats[0] ?? 'gguf'

  return (
    // One line, Uncensored pinned to its end. The row used to wrap, and since a
    // trigger is as wide as its current label, every pick moved Uncensored
    // between lines (GGUF fits beside it, PrismML does not). Where the column
    // is too narrow (TensorRT-LLM, a large font) the triggers' labels truncate.
    <div className={cn('flex items-center gap-2', className)}>
      {availableFormats.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button
              variant="outline"
              size="sm"
              aria-label={t('hub:formats')}
              title={HUB_FORMAT_LABELS[selectedFormat]}
              className={FORMAT_TRIGGER_CLASS}
            >
              <span className="truncate">
                {HUB_FORMAT_LABELS[selectedFormat]}
              </span>
              <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
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
                  {HUB_FORMAT_LABELS[format]}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      )}

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            variant="outline"
            size="sm"
            aria-label={t('hub:sortBy')}
            title={t(SORT_LABEL_KEYS[state.sort])}
            className={SORT_TRIGGER_CLASS}
          >
            <span className="truncate">{t(SORT_LABEL_KEYS[state.sort])}</span>
            <ChevronsUpDown className="size-4 shrink-0 text-muted-foreground" />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent side="bottom" align="start" className="max-w-72">
          <DropdownMenuLabel className="text-xs text-muted-foreground">
            {t('hub:sortBy')}
          </DropdownMenuLabel>
          {sortKeys.map((key) => (
            <DropdownMenuItem
              key={key}
              className={cn(
                'my-0.5 cursor-pointer',
                state.sort === key && 'bg-secondary'
              )}
              onClick={() => onChange({ ...state, sort: key })}
            >
              {t(SORT_LABEL_KEYS[key])}
            </DropdownMenuItem>
          ))}

          <DropdownMenuSeparator />
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
        </DropdownMenuContent>
      </DropdownMenu>

      <button
        type="button"
        role="checkbox"
        aria-checked={state.uncensored}
        title={t('hub:uncensoredHint')}
        onClick={() => onChange({ ...state, uncensored: !state.uncensored })}
        className="ml-auto flex h-8 shrink-0 cursor-pointer items-center gap-2 rounded-md px-2 text-sm text-muted-foreground transition-colors hover:bg-secondary hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring aria-checked:text-foreground"
      >
        <span
          className={cn(
            'flex size-4 shrink-0 items-center justify-center rounded-[5px] border border-input',
            state.uncensored &&
              'border-primary bg-primary text-primary-foreground'
          )}
        >
          {state.uncensored && <Check className="size-3" />}
        </span>
        {t('hub:uncensored')}
      </button>
    </div>
  )
}
