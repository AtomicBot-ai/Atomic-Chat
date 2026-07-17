import { useAppState } from '@/hooks/useAppState'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { Loader } from 'lucide-react'

export function PromptProgress() {
  const { t } = useTranslation('chat')
  const promptProgress = useAppState((state) => state.promptProgress)

  const percentage =
    promptProgress && promptProgress.total > 0
      ? Math.round((promptProgress.processed / promptProgress.total) * 100)
      : 0

  // Show progress only when promptProgress exists and has valid data, and not completed
  if (
    !promptProgress ||
    !promptProgress.total ||
    promptProgress.total <= 0 ||
    percentage >= 100
  ) {
    return <Loader className="h-4 w-4 animate-spin" />
  }

  return (
    <div className="mb-2 flex items-center gap-2 text-sm text-muted-foreground">
      <Loader className="h-4 w-4 animate-spin" />
      <span>{t('activity.reading', { count: percentage })}</span>
    </div>
  )
}
