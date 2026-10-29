import type { ReactNode } from 'react'

import { IconRefresh } from '@tabler/icons-react'

import {
  CORNER_ACTION,
  CORNER_CARD,
  CORNER_PRIMARY_ACTION,
  CornerCardHeader,
  CornerMini,
} from '@/containers/corner/CornerCard'
import { CORNER_ORDER, CornerSlot } from '@/containers/corner/cornerStack'
import { useAutoCollapse } from '@/containers/corner/useAutoCollapse'
import { cn } from '@/lib/utils'

/// One line of the changelog preview: a bold headline and an optional muted
/// continuation. Produced by `parseReleaseHighlights()` for the app banner;
/// the engine banner carries at most the one-line note its manifest has.
export interface UpdateBannerHighlight {
  headline: string
  detail?: string
}

export interface UpdateBannerProps {
  /// e.g. "New llama.cpp update" / "New Atomic Chat version".
  title: string
  /// Version currently in use. Omitted when it is unknown — the transition
  /// line then shows the target alone rather than an arrow from nothing.
  fromVersion?: string | null
  /// Version being offered. Always rendered, in bold.
  toVersion: string
  /// Metadata line under the transition, e.g. "11 MB download · No restart
  /// needed after update" or "A new app update is available".
  subtitle?: ReactNode
  /// Changelog preview. Empty/absent renders no inset block.
  highlights?: UpdateBannerHighlight[]
  /// Already-formatted "+N more" line for the bullets that did not fit.
  /// Omitted renders nothing under the list.
  remainingLabel?: string
  /// Label + handler for the left-hand link ("Show what's new" / "Show
  /// release notes"). Omitted renders no link.
  secondaryAction?: { label: string; onClick: () => void }
  /// When `true`, the highlights inset gives way to `expandedContent` in a
  /// scroll box of fixed height. The container owns the flag and flips the
  /// `secondaryAction` label to match; the banner only draws what it is told.
  expanded?: boolean
  /// Already-rendered full changelog for the expanded state.
  expandedContent?: ReactNode
  /// Small right-aligned link under the expanded box ("Open release").
  expandedAction?: { label: string; onClick: () => void }
  remindLaterLabel: string
  onRemindLater: () => void
  updateLabel: string
  onUpdate: () => void
  /// Disables "Update" and swaps its label while the update is running.
  busy?: boolean
  busyLabel?: string
  /// 0–1. While `busy`, turns "Update" into a bar that fills as the update
  /// downloads, with `busyLabel` inside it, so the banner itself is where the
  /// download shows. Omitted keeps a plain disabled button.
  progress?: number
  /// `false` hides "Remind me later" and the × — for an update that has
  /// started and cannot be stopped, where hiding the banner would only hide
  /// its progress. The card still folds into its pill, which shows it.
  dismissible?: boolean
  dismissLabel: string
  onDismiss: () => void
  /// The header's fold control.
  collapseLabel: string
  /// The folded pill's readout, e.g. "llama.cpp b10909". Defaults to
  /// `toVersion`; replaced by the percent while the update downloads.
  miniLabel?: string
  /// Test hook / DOM anchor. Also used to tell the two banners apart.
  testId?: string
  className?: string
}

/**
 * Bottom-right update card shared by the app-version banner (ATO-533) and the
 * inference-engine banner (ATO-528/531).
 *
 * Purely presentational: every decision about *whether* to offer an update,
 * what it costs and what happens on accept lives in the owning container. The
 * only thing this file owns is that both banners look like one family — the
 * whole reason the two issues asked for a shared component — and like the
 * download panel they stack with (`corner/CornerCard`): the same width,
 * corners, palette and type, the title in the header and the offer in a strip.
 *
 * Like every corner card it folds into a pill three seconds after it appears
 * (`useAutoCollapse`); the pill keeps the version on offer, or the progress
 * once the update runs, and opens the card again. Mounting is coordinated
 * through `update-banner-store` so the app and engine offers never both show.
 */
export function UpdateBanner({
  title,
  fromVersion,
  toVersion,
  subtitle,
  highlights,
  remainingLabel,
  secondaryAction,
  expanded = false,
  expandedContent,
  expandedAction,
  remindLaterLabel,
  onRemindLater,
  updateLabel,
  onUpdate,
  busy = false,
  busyLabel,
  progress,
  dismissible = true,
  dismissLabel,
  onDismiss,
  collapseLabel,
  miniLabel,
  testId,
  className,
}: UpdateBannerProps) {
  const { collapsed, expand, collapse, holdProps } = useAutoCollapse(true)
  const showExpanded = expanded && expandedContent != null
  const hasHighlights = !showExpanded && !!highlights && highlights.length > 0
  const running = busy && progress != null

  if (collapsed) {
    const percent = running
      ? Math.round(Math.min(Math.max(progress, 0), 1) * 100)
      : null
    return (
      <CornerSlot order={CORNER_ORDER.update}>
        <CornerMini
          icon={<IconRefresh size={15} aria-hidden />}
          text={percent !== null ? `${percent}%` : (miniLabel ?? toVersion)}
          progress={running ? progress : null}
          label={title}
          onClick={expand}
          testId={testId ? `${testId}-mini` : undefined}
        />
      </CornerSlot>
    )
  }

  return (
    <CornerSlot order={CORNER_ORDER.update}>
      <div
        role="status"
        aria-live="polite"
        data-testid={testId}
        className={cn(CORNER_CARD, className)}
        {...holdProps}
      >
        <CornerCardHeader
          title={title}
          collapseLabel={collapseLabel}
          onCollapse={collapse}
          dismissLabel={dismissLabel}
          onDismiss={dismissible ? onDismiss : undefined}
        />

        <div className="bg-[var(--dl-row)] px-4 py-3">
          <div className="flex items-start gap-3">
            <span className="flex shrink-0 pt-px text-[var(--dl-strong)]">
              <IconRefresh size={18} aria-hidden />
            </span>
            <div className="min-w-0 flex-1">
              <p className="text-xs leading-[18px] break-words text-[var(--dl-text)]">
                {fromVersion ? (
                  <>
                    <span>{fromVersion}</span>
                    <span aria-hidden="true"> → </span>
                  </>
                ) : null}
                <span className="font-semibold text-[var(--dl-title)]">
                  {toVersion}
                </span>
              </p>
              {subtitle ? (
                <p className="mt-0.5 text-[11px] leading-4 break-words tabular-nums text-[var(--dl-text)]">
                  {subtitle}
                </p>
              ) : null}
            </div>
          </div>

          {showExpanded && (
            <div className="mt-3">
              <div
                data-testid={testId ? `${testId}-notes` : undefined}
                className="max-h-40 overflow-y-auto rounded-lg border border-[var(--dl-divider)] bg-[var(--dl-panel-bg)] px-3 py-2.5 text-[11px] leading-4 text-[var(--dl-text)]"
              >
                {expandedContent}
              </div>
              {expandedAction ? (
                <div className="mt-1 flex justify-end">
                  <button
                    type="button"
                    onClick={expandedAction.onClick}
                    className="cursor-pointer text-[11px] text-[var(--dl-text)] underline underline-offset-2 hover:text-[var(--dl-title)]"
                  >
                    {expandedAction.label}
                  </button>
                </div>
              ) : null}
            </div>
          )}

          {hasHighlights && (
            <div className="mt-2.5 pl-[30px]">
              <ul className="flex flex-col gap-1.5">
                {highlights.map((item, index) => (
                  <li
                    key={`${index}-${item.headline}`}
                    className="flex gap-1.5 text-[11px] leading-4"
                  >
                    <span
                      aria-hidden="true"
                      className="mt-[6px] size-1 shrink-0 rounded-full bg-[var(--dl-progress)]"
                    />
                    <span className="min-w-0">
                      <span className="font-medium text-[var(--dl-title)]">
                        {item.headline}
                      </span>
                      {item.detail ? (
                        <span className="text-[var(--dl-text)]">
                          {' '}
                          {item.detail}
                        </span>
                      ) : null}
                    </span>
                  </li>
                ))}
              </ul>
              {remainingLabel ? (
                <div className="mt-1.5 pl-[10px] text-[11px] leading-4 text-[var(--dl-text)]">
                  {remainingLabel}
                </div>
              ) : null}
            </div>
          )}
        </div>

        {/* Wraps rather than overflowing: three labels of unknown length share
            one row, and a longer translation would otherwise push "Update" off
            the card. When they do not fit, the action pair drops to its own
            right-aligned line and the link keeps the one above it. */}
        <div className="flex flex-wrap items-center justify-end gap-1 border-t border-[var(--dl-divider)] px-2 py-2">
          {secondaryAction ? (
            <button
              type="button"
              onClick={secondaryAction.onClick}
              className={cn(CORNER_ACTION, 'mr-auto max-w-full')}
            >
              <span className="truncate">{secondaryAction.label}</span>
            </button>
          ) : null}
          <div className="flex items-center gap-1">
            {dismissible ? (
              <button
                type="button"
                className={CORNER_ACTION}
                onClick={onRemindLater}
              >
                {remindLaterLabel}
              </button>
            ) : null}
            {running ? (
              <UpdateProgressButton
                progress={progress}
                label={busyLabel ?? updateLabel}
              />
            ) : (
              <button
                type="button"
                className={CORNER_PRIMARY_ACTION}
                onClick={onUpdate}
                disabled={busy}
              >
                {busy ? (busyLabel ?? updateLabel) : updateLabel}
              </button>
            )}
          </div>
        </div>
      </div>
    </CornerSlot>
  )
}

/**
 * The "Update" pill once pressed: the same size and shape, filling with the
 * strip's teal as the update downloads. The label is drawn twice — muted on
 * the track, inverted on the fill, clipped to the same edge — so it stays
 * legible wherever the edge happens to cross it.
 */
function UpdateProgressButton({
  progress,
  label,
}: {
  progress: number
  label: string
}) {
  const percent = Math.round(Math.min(Math.max(progress, 0), 1) * 100)
  const labelClassName =
    'flex h-full items-center justify-center px-3 whitespace-nowrap tabular-nums'

  return (
    <div
      role="progressbar"
      aria-valuemin={0}
      aria-valuemax={100}
      aria-valuenow={percent}
      aria-valuetext={label}
      data-slot="update-progress"
      className="relative h-7 min-w-24 overflow-hidden rounded-full bg-[var(--dl-track)] text-xs font-medium"
    >
      <div className={cn(labelClassName, 'text-[var(--dl-strong)]')}>
        {label}
      </div>
      <div
        aria-hidden="true"
        className={cn(
          labelClassName,
          'absolute inset-0 bg-[var(--dl-progress)] text-[var(--dl-badge-text)] transition-[clip-path] duration-300 ease-out motion-reduce:transition-none'
        )}
        style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
      >
        {label}
      </div>
    </div>
  )
}

export default UpdateBanner
