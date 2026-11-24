import { useEffect, useRef } from 'react'

import { useAppState } from '@/hooks/useAppState'
import { useServiceStore } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatCompactionTokens } from '@/lib/context-compaction'
import type { HistoryCompactedEvent } from '@/lib/core-context-contract'
import type { ApiEventEntry } from '@/types/apiServerLog'
import { makeNotice } from '@/utils/apiServerLogNormalize'

import { useApiServerLog } from './useApiServerLog'

/** The core's `session:history-compacted`, as the Rust relay re-emits it. */
export const HISTORY_COMPACTED_EVENT = 'atomic-core://session:history-compacted'

type Translate = (key: string, options?: Record<string, unknown>) => string

const count = (value: unknown): number | undefined =>
  typeof value === 'number' && Number.isFinite(value) && value >= 0
    ? Math.floor(value)
    : undefined

/**
 * The "History compacted" row for a compaction the public server made of a
 * client's request (`source: 'api'`); `undefined` for any other payload — a
 * compaction a client of the control API asked for is no request of the log.
 */
export function historyCompactedNotice(
  payload: unknown,
  t: Translate,
  now = Date.now()
): ApiEventEntry | undefined {
  if (!payload || typeof payload !== 'object') return undefined
  const event = payload as Partial<Record<keyof HistoryCompactedEvent, unknown>>
  if (event.source !== 'api' || typeof event.modelId !== 'string') {
    return undefined
  }
  const summarized = count(event.summarizedMessages)
  const before = count(event.tokensBefore)
  const after = count(event.tokensAfter)
  const detail =
    summarized !== undefined && before !== undefined && after !== undefined
      ? `${event.modelId} · ${t('api:notice.historyCompactedDetail', {
          count: summarized,
          before: formatCompactionTokens(before),
          after: formatCompactionTokens(after),
        })}`
      : event.modelId
  return makeNotice(
    `notice_${now}_compacted_${event.modelId}`,
    t('api:notice.historyCompacted'),
    detail
  )
}

/**
 * Adds "Model loaded" / "Model unloaded" rows to the request log, and a
 * "History compacted" row whenever the server summarized the oldest turns of
 * a client's request to fit the model's window.
 *
 * These come from the app's own model state and the core's events rather
 * than the proxy: a model load is not an API request, but it is the context a
 * reader needs to make sense of the requests around it.
 */
export function useApiServerModelNotices() {
  const { t } = useTranslation()
  const activeModels = useAppState((state) => state.activeModels)
  const serviceHub = useServiceStore((state) => state.serviceHub)
  // Seeded on first run so mounting the screen does not replay history the
  // user has already lived through.
  const seen = useRef<string[] | null>(null)
  // The listener lives as long as the screen; it reads the latest wording.
  const translate = useRef<Translate>(t)
  translate.current = t

  useEffect(() => {
    const previous = seen.current
    seen.current = activeModels
    if (previous === null) return

    const loaded = activeModels.filter((id) => !previous.includes(id))
    const unloaded = previous.filter((id) => !activeModels.includes(id))
    const ops = [
      ...loaded.map((id) => ({ id, title: t('api:notice.modelLoaded') })),
      ...unloaded.map((id) => ({ id, title: t('api:notice.modelUnloaded') })),
    ]
    if (ops.length === 0) return

    useApiServerLog.getState().applyBatch(
      ops.map(({ id, title }, index) => ({
        t: 'start' as const,
        entry: makeNotice(`notice_${Date.now()}_${index}_${id}`, title, id),
      }))
    )
  }, [activeModels, t])

  useEffect(() => {
    if (!serviceHub) return
    let detach: (() => void) | undefined
    let closed = false
    void serviceHub
      .events()
      .listen<unknown>(HISTORY_COMPACTED_EVENT, (event) => {
        const entry = historyCompactedNotice(event.payload, translate.current)
        if (entry) {
          useApiServerLog.getState().applyBatch([{ t: 'start', entry }])
        }
      })
      .then((unlisten) => {
        if (closed) unlisten()
        else detach = unlisten
      })
    return () => {
      closed = true
      detach?.()
    }
  }, [serviceHub])
}
