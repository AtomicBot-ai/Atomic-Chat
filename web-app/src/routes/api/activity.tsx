import { IconRefresh, IconTrash } from '@tabler/icons-react'
import { createFileRoute } from '@tanstack/react-router'
import { useCallback, useEffect, useMemo, useRef, useState } from 'react'

import { Skeleton } from '@/components/ui/skeleton'
import { route } from '@/constants/routes'
import { ApiRequestInspector } from '@/containers/api/ApiRequestInspector'
import { ApiRequestList } from '@/containers/api/ApiRequestList'
import { ApiStatTiles } from '@/containers/api/ApiStatTiles'
import { ServerButton, ServerPage } from '@/containers/server/ServerPageParts'
import { useApiServerLog, filterEntries } from '@/hooks/useApiServerLog'
import { useApiServerLogFeed } from '@/hooks/useApiServerLogFeed'
import { useApiServerModelNotices } from '@/hooks/useApiServerModelNotices'
import { useLocalApiServerControl } from '@/hooks/useLocalApiServerControl'
import {
  type ListDetailGeometry,
  useStackedListDetail,
} from '@/hooks/useStackedListDetail'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { computeApiServerStats } from '@/utils/apiServerStats'

/**
 * Server → Activity: the Local API Server's requests while Atomic Chat is
 * open — throughput tiles, the request list and the inspector. Starting and
 * stopping the server is the sidebar's job; the address is on Connections.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.api.activity as any)({
  component: ApiActivityPage,
})

/** How often the sliding stats window is recomputed. */
const STATS_TICK_MS = 2000

/**
 * The request list's 380 px column and its 12 px gap, the details' padding
 * and border, and room for their three columns of figures. Narrower, the
 * list takes the page's width and the details open under it.
 */
const LIST_DETAIL: ListDetailGeometry = {
  listWidth: 392,
  detailInset: 34,
  detailMeasureEm: 30,
}

/** Both panes keep one height, side by side or stacked. */
const PANE_HEIGHT = 'grid h-[clamp(320px,46vh,620px)] min-h-0 min-w-0'

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

export function ApiActivityPage() {
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
  const { ref: splitRef, stacked } =
    useStackedListDetail<HTMLDivElement>(LIST_DETAIL)
  const inspectorRef = useRef<HTMLDivElement>(null)

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

  const selectRequest = useCallback(
    (id: string) => {
      select(id)
      if (!stacked) return
      // Under the list, the details may start below the fold.
      requestAnimationFrame(() =>
        inspectorRef.current?.scrollIntoView?.({ block: 'nearest' })
      )
    },
    [select, stacked]
  )

  const clearFilters = useCallback(() => {
    setFilter('all')
    setQuery('')
  }, [setFilter, setQuery])

  return (
    <ServerPage
      layout="dashboard"
      title={t('api:activity.title')}
      description={t('api:activity.description')}
      actions={
        <>
          <ServerButton onClick={() => void handleRefresh()}>
            <IconRefresh
              size={14}
              className={cn(refreshing && 'animate-spin')}
            />
            {t('api:actions.refresh')}
          </ServerButton>
          <ServerButton onClick={() => void clear()}>
            <IconTrash size={14} />
            {t('api:actions.clearLog')}
          </ServerButton>
        </>
      }
    >
      <div className="flex flex-col gap-3">
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

        {/* Side by side when the page has room for both; otherwise the list
            takes the width and a selected request's details open under it,
            with no empty column held for them. */}
        <div
          ref={splitRef}
          data-layout={stacked ? 'stacked' : 'split'}
          className={cn(
            'grid gap-3',
            stacked
              ? 'grid-cols-1'
              : 'grid-cols-[minmax(300px,380px)_minmax(0,1fr)]'
          )}
        >
          <div className={PANE_HEIGHT}>
            <ApiRequestList
              entries={visible}
              filter={filter}
              query={query}
              selectedId={selectedId}
              onSelect={selectRequest}
              onFilterChange={setFilter}
              onQueryChange={setQuery}
              onClearFilters={clearFilters}
              emptyLog={entries.length === 0}
            />
          </div>
          {(!stacked || selectedId !== null) && (
            <div ref={inspectorRef} className={PANE_HEIGHT}>
              <ApiRequestInspector
                entry={selected}
                hasSelection={selectedId !== null}
              />
            </div>
          )}
        </div>
      </div>
    </ServerPage>
  )
}
