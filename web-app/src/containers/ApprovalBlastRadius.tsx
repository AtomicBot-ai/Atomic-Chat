import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { BlastRadius, ChangeReview } from '@/lib/blast-radius'

const VERDICT_STYLES: Record<ChangeReview['verdict'], string> = {
  agree: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  concern: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  disagree: 'border-destructive/50 text-destructive',
  unavailable: 'text-muted-foreground',
}

const RISK_STYLES: Record<BlastRadius['risk'], string> = {
  low: 'border-emerald-500/40 text-emerald-600 dark:text-emerald-400',
  medium: 'border-amber-500/40 text-amber-600 dark:text-amber-400',
  high: 'border-destructive/50 text-destructive',
}

/**
 * Shown on the approval card itself — not behind "details" — so the user
 * sees the consequences of a change before deciding.
 */
export function ApprovalBlastRadius({
  radius,
  agentReason,
  review,
}: {
  radius: BlastRadius
  /** Why the agent wants the change, when it said. */
  agentReason?: string | null
  /** A separate reviewer's verdict on the change. */
  review?: ChangeReview | null
}) {
  const { t } = useTranslation('chat')
  const rows: Array<[string, string]> = [
    [t('agentApproval.blastRadius.agentReason'), agentReason ?? ''],
    [t('agentApproval.blastRadius.changes'), radius.changes],
    [t('agentApproval.blastRadius.disruption'), radius.disruption],
    [t('agentApproval.blastRadius.affects'), radius.affects],
    [t('agentApproval.blastRadius.undo'), radius.undo],
  ]
  return (
    <div
      className="space-y-1.5 rounded-md border bg-background/60 p-2 text-xs"
      data-testid="approval-blast-radius"
    >
      <div className="flex items-start justify-between gap-2">
        <span className="font-medium">{radius.action}</span>
        <span
          className={cn(
            'shrink-0 rounded-full border px-1.5 py-0.5 text-[10px] font-medium uppercase',
            RISK_STYLES[radius.risk]
          )}
        >
          {t(`agentApproval.blastRadius.risk.${radius.risk}`)}
        </span>
      </div>
      <dl className="grid grid-cols-[auto_1fr] gap-x-2 gap-y-1">
        {rows
          .filter(([, value]) => value)
          .map(([label, value]) => (
            <div key={label} className="contents">
              <dt className="text-muted-foreground">{label}</dt>
              <dd>{value}</dd>
            </div>
          ))}
      </dl>
      {(radius.needsAdmin || radius.needsReboot) && (
        <div className="flex flex-wrap gap-1.5">
          {radius.needsAdmin && (
            <span className="rounded border px-1.5 py-0.5 text-[10px]">
              {t('agentApproval.blastRadius.needsAdmin')}
            </span>
          )}
          {radius.needsReboot && (
            <span className="rounded border border-destructive/50 px-1.5 py-0.5 text-[10px] text-destructive">
              {t('agentApproval.blastRadius.needsReboot')}
            </span>
          )}
        </div>
      )}
      {review && (
        <div
          className={cn(
            'rounded border px-2 py-1',
            VERDICT_STYLES[review.verdict]
          )}
          data-testid="approval-review"
        >
          <span className="font-medium">
            {t('agentApproval.blastRadius.review.title')}:{' '}
            {t(`agentApproval.blastRadius.review.${review.verdict}`)}
          </span>
          {review.reason && (
            <span className="text-foreground"> — {review.reason}</span>
          )}
        </div>
      )}
    </div>
  )
}
