import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { ApiServerStats } from '@/utils/apiServerStats'
import {
  formatCount,
  formatMs,
  formatTokensPerSecond,
} from '@/utils/apiServerStats'

import { MicroLabel } from './ApiStatusIndicators'

export function ApiStatTile({
  label,
  value,
  sub,
  className,
}: {
  label: string
  value: string
  sub?: string
  className?: string
}) {
  return (
    <div className={cn('rounded-lg border border-border bg-card p-3', className)}>
      <MicroLabel>{label}</MicroLabel>
      <p className="mt-1 font-studio text-xl font-medium tabular-nums text-foreground">
        {value}
      </p>
      {sub ? (
        <p className="mt-0.5 truncate text-[11px] text-muted-foreground" title={sub}>
          {sub}
        </p>
      ) : (
        // Reserve the row so tiles with and without a subline align.
        <p className="mt-0.5 h-[15px]" aria-hidden />
      )}
    </div>
  )
}

export function ApiStatTiles({ stats }: { stats: ApiServerStats }) {
  const { t } = useTranslation()

  const errorSub =
    stats.errorPctOfFinished === null
      ? undefined
      : t('api:stats.errorShare', {
          percent: Math.round(stats.errorPctOfFinished),
        })

  const latencySub =
    stats.maxLatencyMs === null
      ? undefined
      : t('api:stats.maxLatency', { value: formatMs(stats.maxLatencyMs) })

  const throughputSub =
    stats.throughputTps === null
      ? undefined
      : t('api:stats.throughputDetail', {
          tokens: formatCount(stats.windowCompletionTokens),
          duration: formatMs(stats.windowGenerationMs),
        })

  return (
    <div className="grid grid-cols-2 gap-2 sm:grid-cols-3 xl:grid-cols-6">
      <ApiStatTile
        label={t('api:stats.inFlight')}
        value={formatCount(stats.inFlight)}
      />
      <ApiStatTile
        label={t('api:stats.requests')}
        value={formatCount(stats.windowRequests)}
        sub={t('api:stats.window')}
      />
      <ApiStatTile
        label={t('api:stats.completed')}
        value={formatCount(stats.completed)}
      />
      <ApiStatTile
        label={t('api:stats.errors')}
        value={formatCount(stats.errors)}
        sub={errorSub}
      />
      <ApiStatTile
        label={t('api:stats.avgLatency')}
        value={formatMs(stats.avgLatencyMs)}
        sub={latencySub}
      />
      <ApiStatTile
        label={t('api:stats.throughput')}
        value={formatTokensPerSecond(stats.throughputTps)}
        sub={throughputSub}
      />
    </div>
  )
}
