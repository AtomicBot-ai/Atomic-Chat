import type { ReactNode } from 'react'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { ONBOARDING_ROW_ACTION_CLASS, ROUTE_ROW_BUTTON_HOVER } from './RouteRow'

type SetupModelRowProps = {
  icon: ReactNode
  title: string
  fitMark: ReactNode
  hero: boolean
  downloadSize?: string
  progressText: string | null
  summary: string | null
  rowDownloading: boolean
  disabled: boolean
  onDownload: () => void
  buttonLabel: string
}

/** The onboarding model row, isolated so its actual geometry can be tested. */
export function SetupModelRow({
  icon,
  title,
  fitMark,
  hero,
  downloadSize,
  progressText,
  summary,
  rowDownloading,
  disabled,
  onDownload,
  buttonLabel,
}: SetupModelRowProps) {
  const { t } = useTranslation()
  return (
    <div
      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
      data-testid="setup-recommended-row"
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {icon}
        <div className="min-w-0 flex-1">
          {/* One line: the name truncates, and the badges after it never
                wrap under it, so the badges of every row stand in line. */}
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="min-w-0 truncate text-sm font-medium leading-tight">
              {title}
            </h2>
            {fitMark}
            {downloadSize && (
              <span
                className="shrink-0 whitespace-nowrap text-xs text-muted-foreground"
                data-testid="setup-model-size"
              >
                {downloadSize}
              </span>
            )}
          </div>
          {/* The one line under the name: the summary, or the progress
                readout in its place while the download runs — announced as
                it changes, since nothing else on the row says so. */}
          <p
            className="mt-0.5 truncate min-h-4 text-xs text-muted-foreground tabular-nums"
            aria-live="polite"
          >
            {progressText ?? summary}
          </p>
        </div>
      </div>
      {rowDownloading ? (
        <Button
          variant="secondary"
          size="sm"
          disabled
          aria-live="polite"
          className={cn(ONBOARDING_ROW_ACTION_CLASS, ROUTE_ROW_BUTTON_HOVER)}
        >
          <span className="min-w-0 truncate">{t('setup:downloading')}</span>
        </Button>
      ) : (
        /* The offer keeps the primary fill, not a bigger pill: a taller
             button broke the column of buttons it heads. */
        <Button
          variant={hero ? 'default' : 'secondary'}
          size="sm"
          disabled={disabled}
          onClick={onDownload}
          className={cn(
            ONBOARDING_ROW_ACTION_CLASS,
            !hero && ROUTE_ROW_BUTTON_HOVER
          )}
        >
          <span className="min-w-0 truncate">{buttonLabel}</span>
        </Button>
      )}
    </div>
  )
}
