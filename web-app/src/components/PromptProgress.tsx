import { useAppState } from '@/hooks/useAppState'
import { useInferenceStatus } from '@/hooks/useInferenceStatus'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { AgentActivity } from '@/components/ai-elements/agent-activity'

export function PromptProgress() {
  const { t } = useTranslation('chat')
  const promptProgress = useAppState((state) => state.promptProgress)
  const { phase } = useInferenceStatus()
  const loadingModel = phase === 'starting' || phase === 'restarting'

  const percentage =
    promptProgress && promptProgress.total > 0
      ? Math.round((promptProgress.processed / promptProgress.total) * 100)
      : 0

  const showReadingProgress =
    !loadingModel &&
    promptProgress &&
    promptProgress.total > 0 &&
    percentage > 0 &&
    percentage < 100

  return (
    <AgentActivity
      active
      // While the engine reads a long prompt the label says how far it got,
      // so the wait before the first token is visibly moving.
      workingLabel={
        showReadingProgress
          ? t('activity.reading', { count: percentage })
          : t(loadingModel ? 'activity.loadingModel' : 'activity.working')
      }
      durationLabel=""
      hasDetails={Boolean(showReadingProgress)}
      // Rendered inside the indicator row, not the message flow — the default
      // mb-3 would make this row taller than the shimmer it swaps with.
      className="mb-0"
    >
      {showReadingProgress && (
        <div
          role="progressbar"
          aria-label={t('activity.reading', { count: percentage })}
          aria-valuemin={0}
          aria-valuemax={100}
          aria-valuenow={percentage}
          className="my-1 h-1.5 w-40 overflow-hidden rounded-full bg-muted"
        >
          <div
            className="h-full bg-primary transition-[width]"
            style={{ width: `${percentage}%` }}
          />
        </div>
      )}
    </AgentActivity>
  )
}
