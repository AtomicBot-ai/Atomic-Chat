import { useMemo } from 'react'
import { ChevronsUpDown } from 'lucide-react'
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
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  HUB_SORT_KEYS,
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
  // be a filter that can only ever empty the list.
  const availableFormats: ModelFormat[] = IS_MACOS ? ['gguf', 'mlx'] : ['gguf']
  const sortKeys = HUB_SORT_KEYS.filter(
    (key) => key !== 'likes' || showLikesSort
  )
  // Without a memory reading the checkbox could not filter anything, and the
  // caption would read "Based on : ".
  const canFilterByFit = budgetBytes > 0

  const selectedFormat = state.formats[0] ?? 'gguf'

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

      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button variant="outline" size="sm" aria-label={t('hub:sortBy')}>
            {t(SORT_LABEL_KEYS[state.sort])}
            <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
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
    </div>
  )
}
