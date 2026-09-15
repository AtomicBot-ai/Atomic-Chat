import { createFileRoute, redirect } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { route } from '@/constants/routes'
import { ApiConnectionStrip } from '@/containers/api/ApiConnectionStrip'
import { ApiPageHeaderActions } from '@/containers/api/ApiPageHeaderActions'
import { ApiRequestInspector } from '@/containers/api/ApiRequestInspector'
import { ApiRequestList } from '@/containers/api/ApiRequestList'
import { ApiStatTiles } from '@/containers/api/ApiStatTiles'
import { SettingsPageLayout } from '@/containers/SettingsPageLayout'
import { useApiServerLog, filterEntries } from '@/hooks/useApiServerLog'
import { useApiServerLogFeed } from '@/hooks/useApiServerLogFeed'
import { useApiServerModelNotices } from '@/hooks/useApiServerModelNotices'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { computeApiServerStats } from '@/utils/apiServerStats'

/**
 * The page lives at Settings > API (`/settings/api` renders `ApiPage`). This
 * address stays so older links and bookmarks still land there.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.api.index as any)({
  beforeLoad: () => {
    throw redirect({ to: route.settings.api })
  },
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
    <SettingsPageLayout
      title={t('api:title')}
      actions={
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
      }
    >
      <div className="flex flex-col gap-3">
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
    </SettingsPageLayout>
  )
}
