import type { ReactNode } from 'react'

import { IconChevronDown, IconX } from '@tabler/icons-react'

import { cn } from '@/lib/utils'

// The palette every corner card reads (`--dl-*`): the first-run strip's teal.
import '@/containers/downloads/download-panel.css'

/**
 * The corner's card: the download panel's shell, which the update banners and
 * the managed engine card share so the corner reads as one family — one
 * width, one radius, one palette and one type scale.
 */
export const CORNER_CARD =
  'dl-panel w-[min(22rem,calc(100vw-2rem))] select-none overflow-hidden rounded-[15px] border border-[var(--dl-panel-line)] bg-[var(--dl-panel-bg)] text-sm text-[var(--dl-title)] shadow-[var(--dl-panel-shadow)] animate-in fade-in-0 zoom-in-95 origin-bottom-right duration-150 motion-reduce:animate-none'

/** A strip inside the card: the row background and the row's padding. */
export const CORNER_ROW = 'bg-[var(--dl-row)] px-4 py-3'

/** The header's round icon control. */
const HEADER_BUTTON =
  'grid size-7 shrink-0 cursor-pointer place-items-center rounded-full text-[var(--dl-text)] transition-colors hover:bg-[var(--dl-icon-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dl-progress)]'

/** A text action on a card, quiet. */
export const CORNER_ACTION =
  'inline-flex h-7 min-w-0 cursor-pointer items-center justify-center rounded-full px-3 text-xs font-medium whitespace-nowrap text-[var(--dl-text)] transition-colors hover:bg-[var(--dl-icon-hover)] hover:text-[var(--dl-title)] disabled:pointer-events-none disabled:opacity-60 focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dl-progress)]'

/** The card's one primary action, in the strip's teal. */
export const CORNER_PRIMARY_ACTION = cn(
  CORNER_ACTION,
  'bg-[var(--dl-progress)] text-[var(--dl-badge-text)] hover:bg-[var(--dl-progress)] hover:text-[var(--dl-badge-text)] hover:opacity-90'
)

/**
 * The card's header: what it is about in one line, then the way to fold it
 * and, when the card can be put away, the ×.
 */
export function CornerCardHeader({
  title,
  count,
  collapseLabel,
  onCollapse,
  dismissLabel,
  onDismiss,
}: {
  title: ReactNode
  /** A pill beside the title, shown from 2. */
  count?: number
  collapseLabel: string
  onCollapse: () => void
  dismissLabel?: string
  onDismiss?: () => void
}) {
  return (
    <div className="flex items-center justify-between gap-2 border-b border-[var(--dl-divider)] py-2 pl-4 pr-3">
      {/* The count is a pill rather than part of the sentence: the app's i18n
          layer does no plural selection, and "Downloading {{count}} items"
          would be wrong in every language that inflects. */}
      <p className="flex min-w-0 items-center gap-1.5 text-[13px] font-medium">
        <span className="truncate">{title}</span>
        {count !== undefined && count > 1 && (
          <span className="shrink-0 rounded-full bg-[var(--dl-track)] px-1.5 text-xs tabular-nums text-[var(--dl-strong)]">
            {count}
          </span>
        )}
      </p>
      <div className="flex shrink-0 items-center gap-0.5">
        <button
          type="button"
          className={HEADER_BUTTON}
          onClick={onCollapse}
          aria-label={collapseLabel}
          aria-expanded
        >
          <IconChevronDown size={16} aria-hidden />
        </button>
        {onDismiss && (
          <button
            type="button"
            className={HEADER_BUTTON}
            onClick={onDismiss}
            aria-label={dismissLabel}
          >
            <IconX size={15} aria-hidden />
          </button>
        )}
      </div>
    </div>
  )
}

/** The strip's 3px progress hairline along a card's bottom edge. */
export function CornerProgressLine({
  progress,
  label,
}: {
  /** 0–1. */
  progress: number
  label: string
}) {
  const percent = Math.min(100, Math.max(0, Math.round(progress * 100)))
  return (
    <div
      role="progressbar"
      aria-label={label}
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={`${percent}%`}
      className="h-[3px] bg-[var(--dl-track)]"
    >
      <i
        data-slot="progress-indicator"
        className="block h-full bg-[var(--dl-progress)] transition-[width] duration-500 motion-reduce:transition-none"
        style={{ width: `${percent}%` }}
      />
    </div>
  )
}

const RING_SIZE = 28
const RING_STROKE = 2.5
const RING_RADIUS = (RING_SIZE - RING_STROKE) / 2
const RING_LENGTH = 2 * Math.PI * RING_RADIUS

/**
 * The small version of a corner card: a pill with the card's mark inside a
 * progress ring, one short readout and, for the download panel, how many are
 * running. A click opens the card again.
 */
export function CornerMini({
  icon,
  text,
  progress,
  count,
  label,
  onClick,
  testId,
}: {
  icon: ReactNode
  /** One short readout ("42%", "b11463"); omitted draws the mark alone. */
  text?: ReactNode
  /** 0–1 fills the ring; `null` leaves the bare track. */
  progress?: number | null
  /** A badge shown from 2. */
  count?: number
  /** What the pill opens, for screen readers and the tooltip. */
  label: string
  onClick: () => void
  testId?: string
}) {
  const filled =
    progress == null ? 0 : Math.min(1, Math.max(0, progress)) * RING_LENGTH
  const hasText = text !== undefined && text !== null
  const hasCount = count !== undefined && count > 1
  return (
    <button
      type="button"
      className={cn(
        hasText || hasCount ? 'pr-3' : 'pr-1.5',
        'dl-panel relative flex h-10 max-w-[16rem] cursor-pointer items-center gap-2 rounded-full border border-[var(--dl-panel-line)] bg-[var(--dl-row)] py-1 pl-1.5 text-[var(--dl-strong)] shadow-[var(--dl-panel-shadow)] transition-colors hover:bg-[var(--dl-icon-hover)] focus-visible:outline-2 focus-visible:outline-offset-2 focus-visible:outline-[var(--dl-progress)] animate-in fade-in-0 zoom-in-95 origin-bottom-right duration-150 motion-reduce:animate-none'
      )}
      onClick={onClick}
      aria-label={label}
      aria-expanded={false}
      title={label}
      data-testid={testId}
    >
      <span className="relative grid size-7 shrink-0 place-items-center">
        <svg
          aria-hidden
          className="absolute inset-0 -rotate-90"
          width={RING_SIZE}
          height={RING_SIZE}
          viewBox={`0 0 ${RING_SIZE} ${RING_SIZE}`}
        >
          <circle
            cx={RING_SIZE / 2}
            cy={RING_SIZE / 2}
            r={RING_RADIUS}
            fill="none"
            stroke="var(--dl-track)"
            strokeWidth={RING_STROKE}
          />
          {filled > 0 && (
            <circle
              data-slot="mini-progress"
              cx={RING_SIZE / 2}
              cy={RING_SIZE / 2}
              r={RING_RADIUS}
              fill="none"
              stroke="var(--dl-progress)"
              strokeWidth={RING_STROKE}
              strokeLinecap="round"
              strokeDasharray={`${filled} ${RING_LENGTH}`}
              className="transition-[stroke-dasharray] duration-500 motion-reduce:transition-none"
            />
          )}
        </svg>
        {icon}
      </span>
      {hasText && (
        <span className="min-w-0 truncate text-xs font-semibold tabular-nums">
          {text}
        </span>
      )}
      {hasCount && (
        <span className="shrink-0 rounded-full bg-[var(--dl-progress)] px-1.5 text-[11px] font-semibold tabular-nums text-[var(--dl-badge-text)]">
          {count}
        </span>
      )}
    </button>
  )
}
