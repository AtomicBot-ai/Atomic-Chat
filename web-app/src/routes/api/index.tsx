import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { route } from '@/constants/routes'
import { ApiConnectionStrip } from '@/containers/api/ApiConnectionStrip'
import { ApiPageHeaderActions } from '@/containers/api/ApiPageHeaderActions'
import { ApiRequestInspector } from '@/containers/api/ApiRequestInspector'
import { ApiRequestList } from '@/containers/api/ApiRequestList'
import { ApiStatTiles } from '@/containers/api/ApiStatTiles'
import HeaderPage from '@/containers/HeaderPage'
import { useApiServerLog, filterEntries } from '@/hooks/useApiServerLog'
import { useApiServerLogFeed } from '@/hooks/useApiServerLogFeed'
import { useApiServerModelNotices } from '@/hooks/useApiServerModelNotices'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { computeApiServerStats } from '@/utils/apiServerStats'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.api.index as any)({
  component: ApiPage,
})

/** How often the sliding stats window is recomputed. */
const STATS_TICK_MS = 2000

function useNowTick(intervalMs: number) {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    const tick = () => {
      // No point recomputing a window nobody is looking at.
      if (document.visibilityState === 'visible') setNow(Date.now())
    }
    const id = setInterval(tick, intervalMs)
    return () => clearInterval(id)
  }, [intervalMs])
  return now
}

export function ApiPage() {
  const { t } = useTranslation()
  const { clear, hydrate } = useApiServerLogFeed()
  useApiServerModelNotices()
  const control = useLocalApiServerControl()
  const [refreshing, setRefreshing] = useState(false)

  const entries = useApiServerLog((state) => state.entries)
  const filter = useApiServerLog((state) => state.filter)
  const query = useApiServerLog((state) => state.query)
  const selectedId = useApiServerLog((state) => state.selectedId)
  const hydrated = useApiServerLog((state) => state.hydrated)
  const feedUnavailable = useApiServerLog((state) => state.feedUnavailable)
  const { select, setFilter, setQuery } = useApiServerLog.getState()

  const now = useNowTick(STATS_TICK_MS)
  const stats = useMemo(
    () => computeApiServerStats(entries, now),
    [entries, now]
  )
  const visible = useMemo(
    () => filterEntries(entries, filter, query),
    [entries, filter, query]
  )
  const selected = useMemo(
    () => entries.find((entry) => entry.id === selectedId),
    [entries, selectedId]
  )

  const handleRefresh = useCallback(async () => {
    setRefreshing(true)
    try {
      await Promise.all([control.refreshStatus(), hydrate()])
    } finally {
      setRefreshing(false)
    }
  }, [control, hydrate])

  const clearFilters = useCallback(() => {
    setFilter('all')
    setQuery('')
  }, [setFilter, setQuery])

  return (
    <div className="flex h-svh w-full flex-col">
      {/* Empty: the title lives in the content below, but the bar is still
          needed for the macOS drag region and the sidebar toggle. */}
      <HeaderPage />

      <div className="flex min-h-0 flex-1 flex-col gap-3 overflow-y-auto px-6 pb-6">
        <div
          className={cn(
            'flex flex-wrap items-start justify-between gap-4 pb-2',
            !IS_MACOS && 'pr-30'
          )}
        >
          <div className="min-w-0">
            <h1 className="font-studio text-3xl font-medium text-foreground">
              {t('api:title')}
            </h1>
            <p className="mt-1 text-sm text-muted-foreground">
              {t('api:subtitle')}
            </p>
          </div>
          <ApiPageHeaderActions
            isRunning={control.isRunning}
            isBusy={control.isBusy}
            isModelLoading={control.isModelLoading}
            status={control.status}
            onToggleServer={() => void control.toggle()}
            onRefresh={() => void handleRefresh()}
            onClear={() => void clear()}
            refreshing={refreshing}
          />
        </div>

        <ApiConnectionStrip />

        {hydrated ? (
          <ApiStatTiles stats={stats} />
        ) : (
          <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
            {Array.from({ length: 6 }, (_, index) => (
              <Skeleton key={index} className="h-[86px] rounded-lg" />
            ))}
          </div>
        )}

        {feedUnavailable && (
          <p className="rounded-lg border border-border bg-secondary/30 px-3 py-2 text-xs text-muted-foreground">
            {t('api:log.feedUnavailable')}
          </p>
        )}

        <div className="grid h-[clamp(320px,46vh,620px)] grid-cols-1 gap-3 lg:grid-cols-[minmax(300px,380px)_1fr]">
          <ApiRequestList
            entries={visible}
            filter={filter}
            query={query}
            selectedId={selectedId}
            onSelect={select}
            onFilterChange={setFilter}
            onQueryChange={setQuery}
            onClearFilters={clearFilters}
            emptyLog={entries.length === 0}
          />
          <ApiRequestInspector
            entry={selected}
            hasSelection={selectedId !== null}
          />
        </div>
      </div>
    </div>
  )
}
