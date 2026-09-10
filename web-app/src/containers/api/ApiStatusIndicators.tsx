import type { ApiRequestStatus } from '@/types/apiServerLog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export type StatusTone =
  | 'ready'
  | 'busy'
  | 'idle'
  | 'error'
  | 'warning'
  | 'pending'

const DOT_TONE: Record<StatusTone, string> = {
  ready: 'bg-emerald-500',
  busy: 'bg-blue-500 motion-safe:animate-pulse',
  idle: 'bg-muted-foreground/50',
  error: 'bg-red-500',
  warning: 'bg-amber-500',
  pending: 'bg-amber-500 motion-safe:animate-pulse',
}

export function StatusDot({
  tone,
  className,
}: {
  tone: StatusTone
  className?: string
}) {
  return (
    <span
      aria-hidden
      className={cn(
        'inline-block size-2 shrink-0 rounded-full',
        DOT_TONE[tone],
        className
      )}
    />
  )
}

export const REQUEST_TONE: Record<ApiRequestStatus, StatusTone> = {
  in_flight: 'busy',
  completed: 'ready',
  error: 'error',
  cancelled: 'warning',
}

// There is no shared `badge` primitive in this codebase; this follows the
// pill recipe used by `components/ModelSourceBadge.tsx`.
const BADGE_TONE: Record<ApiRequestStatus, string> = {
  in_flight:
    'border-blue-200 bg-blue-50 text-blue-700 dark:border-blue-800 dark:bg-blue-950/45 dark:text-blue-200',
  completed:
    'border-emerald-200 bg-emerald-50 text-emerald-700 dark:border-emerald-800 dark:bg-emerald-950/45 dark:text-emerald-200',
  error:
    'border-red-200 bg-red-50 text-red-700 dark:border-red-800 dark:bg-red-950/45 dark:text-red-200',
  cancelled:
    'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-200',
}

export function RequestStatusBadge({
  status,
  className,
}: {
  status: ApiRequestStatus
  className?: string
}) {
  const { t } = useTranslation()
  return (
    <span
      className={cn(
        'inline-flex items-center gap-1.5 rounded-md border px-1.5 py-0.5 text-[10px] font-semibold uppercase leading-tight tracking-wider',
        BADGE_TONE[status],
        className
      )}
    >
      <StatusDot tone={REQUEST_TONE[status]} className="size-1.5" />
      {t(`api:log.status.${status}`)}
    </span>
  )
}

/** The small all-caps label used above every value on this screen. */
export function MicroLabel({
  children,
  className,
}: {
  children: React.ReactNode
  className?: string
}) {
  return (
    <p
      className={cn(
        'text-[10px] font-semibold uppercase tracking-wider text-muted-foreground',
        className
      )}
    >
      {children}
    </p>
  )
}
