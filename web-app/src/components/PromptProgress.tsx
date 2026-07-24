import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ActivityDetail,
  AgentActivity,
} from '@/components/ai-elements/agent-activity'

export function PromptProgress() {
  const { t } = useTranslation('chat')
  const promptProgress = useAppState((state) => state.promptProgress)

  const percentage =
    promptProgress && promptProgress.total > 0
      ? Math.round((promptProgress.processed / promptProgress.total) * 100)
      : 0

  const showReadingProgress =
    promptProgress &&
    promptProgress.total > 0 &&
    percentage > 0 &&
    percentage < 100

  return (
    <AgentActivity
      active
      workingLabel={t('activity.working')}
      durationLabel=""
      hasDetails={Boolean(showReadingProgress)}
    >
      {showReadingProgress && (
        <ActivityDetail label={t('activity.reading', { count: percentage })}>
          <div className="h-1.5 overflow-hidden rounded-full bg-muted">
            <div
              className="h-full bg-primary transition-[width]"
              style={{ width: `${percentage}%` }}
            />
          </div>
        </ActivityDetail>
      )}
    </AgentActivity>
  )
}
