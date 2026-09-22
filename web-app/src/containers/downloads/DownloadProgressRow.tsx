import { Button } from '@/components/ui/button'
import { Progress } from '@/components/ui/progress'
import { formatDownloadReadout, shortModelName } from '@/lib/downloadFormat'
import { quantFromModelId } from '@/lib/telemetry'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { IconPlayerPause, IconPlayerPlay, IconX } from '@tabler/icons-react'

//* Product blue: downloading is activity, not the green "ready" state.
export const DOWNLOAD_PROGRESS_INDICATOR = 'bg-blue-500/60 dark:bg-blue-400/55'

/** Status while a transfer has no bytes to report — see `useDownloadStore`. */
export type DownloadRowStage = {
  kind: string
  attempt: number
  maxAttempts: number
}

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
  /**
   * ATO — #290: set while the downloader is inside a retry ladder. Without it
   * a host that refuses connections is indistinguishable from a transfer that
   * has simply not started, for the full ~60s the ladders take.
   */
  stage?: DownloadRowStage
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
  stage,
  paused,
  pausable,
  onPause,
  onResume,
  onCancel,
}: DownloadRowProps) {
  const { t } = useTranslation()

  const label = name || id
  const quant = quantFromModelId(id)
  const readout = formatDownloadReadout(t, {
    progress,
    current,
    total,
    bytesPerSecond,
    stage,
    paused,
  })

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

      {/* One line that never wraps: it used to be two flex spans, and past the
          row's width the first one broke at its spaces, so the size pair
          dropped to a second line and the bottom-anchored card grew upwards.
          `truncate` cuts an overlong line at its end — the estimate, the part
          that matters least — instead. `aria-live` is deliberately absent: this
          text changes every few seconds and would talk over everything else. */}
      <p className="truncate text-xs tabular-nums text-muted-foreground">
        {readout}
      </p>
    </li>
  )
}
