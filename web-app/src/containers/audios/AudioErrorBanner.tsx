import { memo } from 'react'
import { IconAlertTriangle, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { describeAudioError, type AudioErrorAction } from '@/lib/audio/errors'
import type { AudioErrorBody } from '@/services/audio/types'

type AudioErrorBannerProps = {
  error: AudioErrorBody | null
  onAction: (action: AudioErrorAction) => void
  onDismiss: () => void
}

/**
 * The one place a job or load failure is shown on the Audios page: a plain
 * title and body for every code, and the action that fixes it. The engine's own
 * words appear only for what it refused, the one case they explain.
 */
export const AudioErrorBanner = memo(function AudioErrorBanner({
  error,
  onAction,
  onDismiss,
}: AudioErrorBannerProps) {
  const { t } = useTranslation()
  if (!error) return null
  const described = describeAudioError(error.code)
  const { action } = described

  return (
    <div
      role="alert"
      data-testid="audio-error-banner"
      data-code={error.code}
      className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
    >
      <IconAlertTriangle
        size={18}
        className="mt-0.5 shrink-0 text-destructive"
      />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{t(described.titleKey)}</p>
        <p className="text-xs text-muted-foreground">{t(described.bodyKey)}</p>
        {described.showsDetails && error.details && (
          <p className="text-xs break-words text-muted-foreground">
            {error.details}
          </p>
        )}
        {action && (
          <div className="pt-1">
            <Button
              size="sm"
              variant="outline"
              onClick={() => onAction(action)}
            >
              {t(`audios:errors.actions.${action}`)}
            </Button>
          </div>
        )}
      </div>
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('common:close')}
        onClick={onDismiss}
      >
        <IconX size={14} />
      </Button>
    </div>
  )
})
