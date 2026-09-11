import { memo } from 'react'
import { IconAlertTriangle, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  describeDiffusionError,
  errorActionLabelKey,
  type DiffusionErrorAction,
} from '@/lib/diffusion/errors'
import type { DiffusionError } from '@/services/diffusion/types'

type ImageErrorBannerProps = {
  error: DiffusionError | null
  onAction: (action: DiffusionErrorAction) => void
  onDismiss: () => void
}

/**
 * The one place a native error is shown on the Images page.
 *
 * Routes through `describeDiffusionError`, so every code gets a title, a
 * body and the action that actually fixes it — OOM offers a smaller size and
 * a smaller quant, a missing engine offers Install — instead of a toast with
 * the raw message. The message is still shown underneath for the cases the
 * copy cannot anticipate.
 */
export const ImageErrorBanner = memo(function ImageErrorBanner({
  error,
  onAction,
  onDismiss,
}: ImageErrorBannerProps) {
  const { t } = useTranslation()
  if (!error) return null
  const described = describeDiffusionError(error.code)

  return (
    <div
      role="alert"
      data-testid="image-error-banner"
      className="flex items-start gap-3 rounded-lg border border-destructive/30 bg-destructive/5 p-3"
    >
      <IconAlertTriangle size={18} className="mt-0.5 shrink-0 text-destructive" />
      <div className="min-w-0 flex-1 space-y-1">
        <p className="text-sm font-medium">{t(described.titleKey)}</p>
        <p className="text-xs text-muted-foreground">{t(described.bodyKey)}</p>
        {error.message && (
          <p className="break-words font-mono text-[11px] text-muted-foreground/80">
            {error.message}
          </p>
        )}
        {(described.action || described.secondaryAction) && (
          <div className="flex flex-wrap gap-2 pt-1">
            {described.action && (
              <Button
                size="sm"
                variant="outline"
                onClick={() => onAction(described.action as DiffusionErrorAction)}
              >
                {t(errorActionLabelKey(described.action))}
              </Button>
            )}
            {described.secondaryAction && (
              <Button
                size="sm"
                variant="ghost"
                onClick={() =>
                  onAction(described.secondaryAction as DiffusionErrorAction)
                }
              >
                {t(errorActionLabelKey(described.secondaryAction))}
              </Button>
            )}
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

export default ImageErrorBanner
