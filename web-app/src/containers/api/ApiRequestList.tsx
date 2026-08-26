import { IconChevronDown, IconSearch } from '@tabler/icons-react'
import { useVirtualizer } from '@tanstack/react-virtual'
import { useMemo, useRef } from 'react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuRadioGroup,
  DropdownMenuRadioItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { ApiLogEntry, ApiLogFilter } from '@/types/apiServerLog'
import { endpointLabel } from '@/utils/apiServerLogNormalize'
import { formatMs, formatTime } from '@/utils/apiServerStats'

import { REQUEST_TONE, StatusDot } from './ApiStatusIndicators'

const FILTERS: ApiLogFilter[] = [
  'all',
  'in_flight',
  'completed',
  'errors',
  'cancelled',
]

/** Generation rate for one finished request, or `null` when unknowable. */
function rowRate(entry: ApiLogEntry): number | null {
  if (entry.kind !== 'request') return null
  if (entry.predictedPerSecond) return entry.predictedPerSecond
  if (!entry.completionTokens || !entry.durationMs) return null
  const generationMs = Math.max(entry.durationMs - (entry.ttftMs ?? 0), 1)
  return entry.completionTokens / (generationMs / 1000)
}

function ApiRequestRow({
  entry,
  selected,
  onSelect,
}: {
  entry: ApiLogEntry
  selected: boolean
  onSelect: () => void
}) {
  const rate = rowRate(entry)
  const preview =
    entry.kind === 'request'
      ? (entry.replyPreview ?? entry.promptPreview)
      : entry.detail

  return (
    <button
      type="button"
      onClick={onSelect}
      className={cn(
        'flex w-full flex-col gap-1 rounded-lg border border-transparent px-2 py-2 text-left transition-colors hover:bg-accent',
        selected && 'border-border bg-accent'
      )}
    >
      <div className="flex w-full items-center gap-2">
        <StatusDot
          tone={entry.kind === 'request' ? REQUEST_TONE[entry.status] : 'idle'}
        />
        <span className="truncate font-mono text-xs text-foreground">
          {entry.kind === 'request'
            ? endpointLabel(entry.endpoint)
            : entry.title}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {entry.kind === 'request' && entry.durationMs !== undefined
            ? formatMs(entry.durationMs)
            : ''}
        </span>
      </div>
      <div className="flex w-full items-center gap-2 pl-4">
        <span className="truncate text-xs text-muted-foreground">
          {entry.kind === 'request' ? (entry.model ?? '—') : entry.detail}
        </span>
        <span className="ml-auto shrink-0 text-[11px] tabular-nums text-muted-foreground">
          {rate ? `${rate.toFixed(1)} tok/s` : ''}
          {'  '}
          {formatTime(entry.startedAt)}
        </span>
      </div>
      {preview && entry.kind === 'request' && (
        <p className="line-clamp-1 pl-4 text-xs text-muted-foreground/80">
          {preview}
        </p>
      )}
    </button>
  )
}

export function ApiRequestList({
  entries,
  filter,
  query,
  selectedId,
  onSelect,
  onFilterChange,
  onQueryChange,
  onClearFilters,
  emptyLog,
}: {
  entries: ApiLogEntry[]
  filter: ApiLogFilter
  query: string
  selectedId: string | null
  onSelect: (id: string) => void
  onFilterChange: (filter: ApiLogFilter) => void
  onQueryChange: (query: string) => void
  onClearFilters: () => void
  emptyLog: boolean
}) {
  const { t } = useTranslation()
  const scrollRef = useRef<HTMLDivElement>(null)

  const virtualizer = useVirtualizer({
    count: entries.length,
    getScrollElement: () => scrollRef.current,
    estimateSize: () => 64,
    overscan: 8,
  })
  const items = virtualizer.getVirtualItems()

  const filterLabel = useMemo(
    () => t(`api:log.filter.${filter}`),
    [filter, t]
  )

  return (
    <div className="flex min-h-0 flex-col rounded-lg border border-border bg-card">
      <div className="flex items-center gap-2 border-b border-border p-2">
        <div className="relative min-w-0 flex-1">
          <IconSearch
            size={14}
            className="pointer-events-none absolute left-2.5 top-1/2 -translate-y-1/2 text-muted-foreground"
          />
          <Input
            value={query}
            onChange={(event) => onQueryChange(event.target.value)}
            placeholder={t('api:log.searchPlaceholder')}
            className="h-8 pl-8 text-xs"
          />
        </div>
        <DropdownMenu>
          <DropdownMenuTrigger asChild>
            <Button variant="outline" size="sm" className="shrink-0">
              {filterLabel}
              <IconChevronDown size={14} />
            </Button>
          </DropdownMenuTrigger>
          <DropdownMenuContent align="end">
            <DropdownMenuRadioGroup
              value={filter}
              onValueChange={(value) => onFilterChange(value as ApiLogFilter)}
            >
              {FILTERS.map((value) => (
                <DropdownMenuRadioItem key={value} value={value}>
                  {t(`api:log.filter.${value}`)}
                </DropdownMenuRadioItem>
              ))}
            </DropdownMenuRadioGroup>
          </DropdownMenuContent>
        </DropdownMenu>
      </div>

      <div ref={scrollRef} className="min-h-0 flex-1 overflow-y-auto p-1">
        {entries.length === 0 ? (
          <div className="flex h-full flex-col items-center justify-center gap-2 p-6 text-center">
            <p className="max-w-xs text-sm text-muted-foreground">
              {emptyLog ? t('api:log.empty') : t('api:log.noMatches')}
            </p>
            {!emptyLog && (
              <Button variant="ghost" size="sm" onClick={onClearFilters}>
                {t('api:log.clearFilters')}
              </Button>
            )}
          </div>
        ) : (
          <div
            style={{ height: virtualizer.getTotalSize(), position: 'relative' }}
          >
            {items.map((item) => {
              const entry = entries[item.index]
              return (
                <div
                  key={entry.id}
                  ref={virtualizer.measureElement}
                  data-index={item.index}
                  style={{
                    position: 'absolute',
                    top: 0,
                    left: 0,
                    width: '100%',
                    transform: `translateY(${item.start}px)`,
                  }}
                >
                  <ApiRequestRow
                    entry={entry}
                    selected={entry.id === selectedId}
                    onSelect={() => onSelect(entry.id)}
                  />
                </div>
              )
            })}
          </div>
        )}
      </div>
    </div>
  )
}
