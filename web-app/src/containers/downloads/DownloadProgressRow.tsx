import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import {
  formatEta,
  formatProgressPair,
  formatSpeed,
  shortModelName,
} from '@/lib/downloadFormat'
import { quantFromModelId } from '@/lib/telemetry'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconPlayerPause, IconPlayerPlay, IconX } from '@tabler/icons-react'

//* Полупрозрачная зелень: текст % и ГБ остаётся читаемым в светлой и тёмной теме
export const DOWNLOAD_PROGRESS_INDICATOR =
  'bg-emerald-400/50 dark:bg-emerald-400/45'

export type DownloadRowProps = {
  /** Stable id, also the tooltip text: the full `org/repo` the user picked. */
  id: string
  /** Display label; falls back to `id` when the download has no friendlier name. */
  name?: string
  progress: number
  current: number
  total: number
  /** Smoothed bytes/second, or 0 before the first usable sample. */
  bytesPerSecond?: number
  paused?: boolean
  /** Pause/resume is offered only for resumable (GGUF) transfers. */
  pausable?: boolean
  onPause?: () => void
  onResume?: () => void
  onCancel?: () => void
}

/**
 * ATO-462: one download, rendered the same everywhere.
 *
 * The old popover showed a percentage and a byte pair and nothing else, inside
 * a 28px ring that auto-hid after 3.5 seconds. A model download is the longest
 * stretch of the first session — median 7 minutes, an hour at p90 for large
 * models — so the row states plainly what is being fetched, how far along it
 * is, how fast, and how much longer.
 */
export function DownloadProgressRow({
  id,
  name,
  progress,
  current,
  total,
  bytesPerSecond,
  paused,
  pausable,
  onPause,
  onResume,
  onCancel,
}: DownloadRowProps) {
  const { t } = useTranslation()

  const label = name || id
  const quant = quantFromModelId(id)
  const known = total > 0
  const speed = paused ? null : formatSpeed(bytesPerSecond)
  const eta = paused ? null : formatEta(total - current, bytesPerSecond)

  // Before the first byte the transfer has no meaningful numbers at all; saying
  // "0%" there reads as a stalled download rather than a starting one.
  const status = paused
    ? t('common:downloadPanel.paused')
    : known
      ? `${Math.round(progress * 100)}%`
      : t('common:downloadPanel.preparing')

  return (
    <li className="rounded-lg bg-secondary p-2">
      <div className="flex items-start justify-between gap-2">
        <div className="min-w-0 flex-1">
          <p className="truncate font-medium" title={id}>
            {shortModelName(label)}
          </p>
          {quant && (
            <p className="truncate text-xs text-muted-foreground">{quant}</p>
          )}
        </div>
        <div className="flex shrink-0 items-center space-x-0.5">
          {pausable &&
            (paused ? (
              <Button
                variant="secondary"
                size="icon-xs"
                onClick={onResume}
                aria-label={t('common:resumeDownload')}
              >
                <IconPlayerPlay
                  size={16}
                  className="cursor-pointer text-muted-foreground"
                />
              </Button>
            ) : (
              <Button
                variant="secondary"
                size="icon-xs"
                onClick={onPause}
                aria-label={t('common:pauseDownload')}
              >
                <IconPlayerPause
                  size={16}
                  className="cursor-pointer text-muted-foreground"
                />
              </Button>
            ))}
          <Button
            variant="secondary"
            size="icon-xs"
            onClick={onCancel}
            aria-label={t('common:cancelDownload')}
          >
            <IconX size={16} className="cursor-pointer text-muted-foreground" />
          </Button>
        </div>
      </div>

      <Progress
        value={progress * 100}
        indicatorClassName={DOWNLOAD_PROGRESS_INDICATOR}
        className="my-2 h-1.5 rounded-full bg-muted-foreground/15 dark:bg-muted-foreground/20"
      />

      <div className="flex items-center justify-between gap-2 text-xs tabular-nums text-muted-foreground">
        <span>
          {status}
          {known && ` · ${formatProgressPair(current, total)}`}
        </span>
        {/* `aria-live` is deliberately absent: this text changes every few
            seconds and would otherwise talk over everything else. */}
        <span className="truncate">
          {[speed, eta && t('common:downloadPanel.left', { eta })]
            .filter(Boolean)
            .join(' · ')}
        </span>
      </div>
    </li>
  )
}
