import { useMemo } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuCheckboxItem,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { useHardware } from '@/hooks/useHardware'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  formatMemoryBudget,
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

export type HubFiltersProps = {
  state: HubFilterState
  onChange: (next: HubFilterState) => void
  /** Hide the Likes option when the current data carries no like counts. */
  showLikesSort?: boolean
  /** The device filter only makes sense for the curated list. */
  showFitFilter?: boolean
  className?: string
}

export function HubFilters({
  state,
  onChange,
  showLikesSort = false,
  showFitFilter = true,
  className,
}: HubFiltersProps) {
  const { t } = useTranslation()
  const { cpu, os_name, total_memory, gpus } = useHardware(
    useShallow((s) => ({
      cpu: s.hardwareData.cpu,
      os_name: s.hardwareData.os_name,
      total_memory: s.hardwareData.total_memory,
      gpus: s.hardwareData.gpus,
    }))
  )

  const budgetBytes = useMemo(
    () => getMemoryBudgetBytes({ total_memory, gpus }),
    [total_memory, gpus]
  )
  const deviceName = cpu?.name || os_name || ''

  // MLX only exists on Apple Silicon, so offering the toggle elsewhere would
  // be a filter that can only ever empty the list.
  const availableFormats: ModelFormat[] = IS_MACOS ? ['gguf', 'mlx'] : ['gguf']
  const sortKeys = HUB_SORT_KEYS.filter(
    (key) => key !== 'likes' || showLikesSort
  )
  // Without a memory reading the checkbox could not filter anything, and the
  // caption would read "Based on : ".
  const canFilterByFit = showFitFilter && budgetBytes > 0

  const toggleFormat = (format: ModelFormat) => {
    const next = state.formats.includes(format)
      ? state.formats.filter((f) => f !== format)
      : [...state.formats, format]
    onChange({ ...state, formats: next })
  }

  const formatsLabel =
    state.formats.length === 0 || state.formats.length >= availableFormats.length
      ? t('hub:allFormats')
      : state.formats.map((f) => f.toUpperCase()).join(', ')

  return (
    <div className={cn('flex items-center gap-2', className)}>
      {availableFormats.length > 1 && (
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" aria-label={t('hub:formats')}>
              {formatsLabel}
              <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent side="bottom" align="start">
            {availableFormats.map((format) => (
              <DropdownMenuCheckboxItem
                key={format}
                checked={state.formats.includes(format)}
                onCheckedChange={() => toggleFormat(format)}
              >
                {format.toUpperCase()}
              </DropdownMenuCheckboxItem>
            ))}
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

          {canFilterByFit && (
            <>
              <DropdownMenuSeparator />
              <DropdownMenuCheckboxItem
                checked={state.onlyFitting}
                // Toggling a filter is not "picking one option and moving on":
                // keep the menu open so the effect on the list is visible.
                onSelect={(event) => event.preventDefault()}
                onCheckedChange={(checked) =>
                  onChange({ ...state, onlyFitting: checked === true })
                }
                className="items-start whitespace-normal"
              >
                {t('hub:onlyFitting')}
              </DropdownMenuCheckboxItem>
              <p className="px-2 pb-1 pl-8 text-xs text-muted-foreground">
                {t('hub:basedOnDevice', {
                  device: deviceName,
                  memory: formatMemoryBudget(budgetBytes),
                })}
              </p>
            </>
          )}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
