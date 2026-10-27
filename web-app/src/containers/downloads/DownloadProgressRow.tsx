import { OverflowText } from '@/components/OverflowText'
import { formatDownloadStatusLine, shortModelName } from '@/lib/downloadFormat'
import { quantFromModelId } from '@/lib/telemetry'
import { cn } from '@/lib/utils'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  IconDownload,
  IconPlayerPause,
  IconPlayerPlay,
  IconX,
} from '@tabler/icons-react'

import './download-panel.css'

//* The first-run strip's teal: the same activity colour as the setup screen.
export const DOWNLOAD_PROGRESS_INDICATOR = 'bg-[var(--dl-progress)]'

/** The strip's round control: 32px, a hairline ring, the icon in teal. */
const ROUND_BUTTON =
  'grid size-8 cursor-pointer place-items-center rounded-full border border-[var(--dl-icon-line)] text-[var(--dl-strong)] transition-colors hover:bg-[var(--dl-icon-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dl-progress)]'

/** Status while a transfer has no bytes to report — see `useDownloadStore`. */
export type DownloadRowStage = {
  kind: string
  attempt: number
  maxAttempts: number
  retrySeconds?: number
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
  /** Recovery explanation overrides the transport status. */
  statusText?: string
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
 *
 * Drawn as the first-run strip (`onboarding/DownloadStrip`): the download
 * mark, the name over one status line, the percent and round controls on the
 * right, and a hairline of progress along the bottom edge.
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
  statusText,
  pausable,
  onPause,
  onResume,
  onCancel,
}: DownloadRowProps) {
  const { t } = useTranslation()

  const label = shortModelName(name || id)
  // Most names already end in their quant; the rest get it beside the name.
  const quant = quantFromModelId(id)
  const quantApart =
    quant && !label.toLowerCase().includes(quant.toLowerCase()) ? quant : null
  // The panel is narrow: a running transfer's line is its size and estimate,
  // the icon, the bar and Pause already say it is downloading.
  const line = statusText ?? formatDownloadStatusLine(
    t,
    { current, total, bytesPerSecond, stage, paused },
    { runningWord: false }
  )
  const percent = total > 0 ? Math.round(progress * 100) : null
  const barPercent = Math.min(100, Math.max(0, Math.round(progress * 100)))
  const reconnecting =
    !paused && (stage?.kind === 'stalled' || stage?.kind === 'retrying')

  return (
    <li
      className={cn(
        'dl-row overflow-hidden bg-[var(--dl-row)]',
        reconnecting && 'is-warn'
      )}
    >
      <div className="flex items-center gap-3 px-4 py-3">
        <span className="flex shrink-0 text-[var(--dl-strong)]">
          <IconDownload size={18} aria-hidden />
        </span>
        <div className="min-w-0 flex-1">
          <OverflowText
            className="text-xs font-semibold text-[var(--dl-title)]"
            title={id}
            text={quantApart ? `${label} · ${quantApart}` : label}
          />
          {/* One line that never wraps: overflow scrolls without growing the
              bottom-anchored card. The percentage and controls stay fixed. `aria-live` is deliberately
              absent: this text changes every few seconds and would talk over
              everything else. */}
          <OverflowText text={line} className="mt-0.5 text-[11px] tabular-nums text-[var(--dl-text)]" />
        </div>
        {percent !== null && (
          <b data-testid="download-percent" className="shrink-0 text-xs font-medium tabular-nums text-[var(--dl-strong)]">
            {percent}%
          </b>
        )}
        <div className="flex shrink-0 items-center gap-1.5">
          {pausable &&
            (paused ? (
              <button
                type="button"
                className={ROUND_BUTTON}
                onClick={onResume}
                aria-label={t('common:resumeDownload')}
              >
                <IconPlayerPlay size={15} aria-hidden />
              </button>
            ) : (
              <button
                type="button"
                className={ROUND_BUTTON}
                onClick={onPause}
                aria-label={t('common:pauseDownload')}
              >
                <IconPlayerPause size={15} aria-hidden />
              </button>
            ))}
          <button
            type="button"
            className={ROUND_BUTTON}
            onClick={onCancel}
            aria-label={t('common:cancelDownload')}
          >
            <IconX size={15} aria-hidden />
          </button>
        </div>
      </div>

      {/* The strip's hairline, filled by width as on the setup screen: a
          translated fill would sit outside the row it is clipped by. */}
      <div
        role="progressbar"
        aria-label={label}
        aria-valuemin={0}
        aria-valuemax={100}
        aria-valuenow={barPercent}
        aria-valuetext={`${barPercent}%`}
        className="h-[3px] bg-[var(--dl-track)]"
      >
        <i
          data-slot="progress-indicator"
          className={cn(
            'block h-full transition-[width] duration-500 motion-reduce:transition-none',
            DOWNLOAD_PROGRESS_INDICATOR
          )}
          style={{ width: `${barPercent}%` }}
        />
      </div>
    </li>
  )
}
