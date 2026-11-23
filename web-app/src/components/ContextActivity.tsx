import {
  IDLE_CONTEXT_ACTIVITY,
  useAppState,
  type PromptProgress,
} from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { AgentActivity } from '@/components/ai-elements/agent-activity'
import { formatContextLength } from '@/lib/model-card'

/** A token count the way the app labels context sizes ("16K"), exact below one K. */
function formatTokens(tokens: number): string {
  return tokens < 1024
    ? String(Math.max(0, Math.round(tokens)))
    : (formatContextLength(tokens) ?? String(tokens))
}

/** How far the engine has read the prompt, when it reports it. */
function readingOf(
  progress: PromptProgress | undefined
): { done: number; total: number; percentage: number } | undefined {
  if (!progress || !(progress.total > 0)) return undefined
  const done = Math.min(Math.max(progress.processed, 0), progress.total)
  return {
    done,
    total: progress.total,
    percentage: Math.round((done / progress.total) * 100),
  }
}

/**
 * The indicator row while the app works on a chat's context window instead of
 * answering: the model reloading with a larger window ("Adding context: 16K →
 * 64K", then "Restarting the model…") or the history being compacted, and, as
 * soon as the engine reports it, how much of the conversation it has read.
 *
 * Shown by the thread page only while such work is under way; with no activity
 * recorded for `threadId` yet it reads as a growth whose size is not known.
 */
export function ContextActivity({ threadId }: { threadId?: string }) {
  const { t } = useTranslation('chat')
  const stored = useAppState((state) => state.contextActivity)
  const promptProgress = useAppState((state) => state.promptProgress)
  const activity =
    stored.phase !== null &&
    (threadId === undefined ||
      stored.threadId === undefined ||
      stored.threadId === threadId)
      ? stored
      : IDLE_CONTEXT_ACTIVITY
  const phase = activity.phase ?? 'expanding'
  const reading = readingOf(promptProgress)

  const title =
    phase === 'compacting'
      ? t('contextActivity.compacting')
      : activity.from !== undefined &&
          activity.to !== undefined &&
          activity.to > activity.from
        ? t('contextActivity.expanding', {
            from: formatTokens(activity.from),
            to: formatTokens(activity.to),
          })
        : t('contextActivity.expandingPending')
  const detail = reading
    ? t('contextActivity.reading', {
        done: formatTokens(reading.done),
        total: formatTokens(reading.total),
      })
    : phase === 'expanding'
      ? t('contextActivity.restarting')
      : undefined

  return (
    <AgentActivity
      active
      workingLabel={title}
      durationLabel=""
      hasDetails={detail !== undefined}
      // What is going on is the point of this row: its detail is open from
      // the start rather than behind the chevron.
      defaultOpen
      // Rendered inside the indicator row (a flex row), not the message flow:
      // no bottom margin, and free to shrink so the readout truncates.
      className="mb-0 min-w-0"
    >
      {detail !== undefined && (
        <div
          data-testid="context-activity-detail"
          className="space-y-1.5 py-0.5"
        >
          <p className="truncate tabular-nums">{detail}</p>
          {reading && (
            <div className="flex items-center gap-2">
              <div
                role="progressbar"
                aria-label={detail}
                aria-valuemin={0}
                aria-valuemax={100}
                aria-valuenow={reading.percentage}
                className="h-1.5 w-40 shrink-0 overflow-hidden rounded-full bg-muted"
              >
                <div
                  className="h-full bg-primary transition-[width]"
                  style={{ width: `${reading.percentage}%` }}
                />
              </div>
              <span className="shrink-0 tabular-nums">
                {reading.percentage}%
              </span>
            </div>
          )}
        </div>
      )}
    </AgentActivity>
  )
}
