import type { ReactNode } from 'react'
import { createPortal } from 'react-dom'

import { IconDownload, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
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
  /// its progress.
  dismissible?: boolean
  dismissLabel: string
  onDismiss: () => void
  /// Test hook / DOM anchor. Also used to tell the two banners apart.
  testId?: string
  className?: string
}

/**
 * Bottom-right update toast shared by the app-version banner (ATO-533) and the
 * inference-engine banner (ATO-528/531).
 *
 * Purely presentational: every decision about *whether* to offer an update,
 * what it costs and what happens on accept lives in the owning container. The
 * only thing this file owns is that both banners look like one family — the
 * whole reason the two issues asked for a shared component.
 *
 * Mounting is coordinated through `update-banner-store` so the app and engine
 * banners never stack in the same corner.
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
  testId,
  className,
}: UpdateBannerProps) {
  const showExpanded = expanded && expandedContent != null
  const hasHighlights = !showExpanded && !!highlights && highlights.length > 0

  const banner = (
    <div
      role="status"
      aria-live="polite"
      data-testid={testId}
      className={cn(
        'fixed z-40 bottom-[calc(1rem+var(--download-panel-offset,0px))] right-2 w-[min(24rem,calc(100vw-1rem))]',
        'transition-[bottom] duration-200',
        'rounded-xl border bg-background shadow-md',
        className
      )}
    >
      {dismissible ? (
        <Button
          variant="ghost"
          size="icon-xs"
          aria-label={dismissLabel}
          onClick={onDismiss}
          className="absolute right-1.5 top-1.5 text-muted-foreground"
        >
          <IconX size={14} />
        </Button>
      ) : null}

      <div className="flex items-start gap-2.5 px-4 pt-4 pr-9">
        <IconDownload
          size={18}
          className="mt-0.5 shrink-0 text-muted-foreground"
        />
        <div className="min-w-0 flex-1">
          <div className="text-sm font-medium leading-5">{title}</div>
          <div className="mt-0.5 text-xs leading-5 text-muted-foreground break-words">
            {fromVersion ? (
              <>
                <span>{fromVersion}</span>
                <span aria-hidden="true"> → </span>
              </>
            ) : null}
            <span className="font-semibold text-foreground">{toVersion}</span>
          </div>
          {subtitle ? (
            <div className="mt-0.5 text-[11px] leading-4 text-muted-foreground break-words">
              {subtitle}
            </div>
          ) : null}
        </div>
      </div>

      {showExpanded && (
        <div className="px-4 pt-3">
          <div
            data-testid={testId ? `${testId}-notes` : undefined}
            className="max-h-40 overflow-y-auto rounded-lg bg-muted/60 px-3 py-2.5 text-[11px] leading-4 text-muted-foreground"
          >
            {expandedContent}
          </div>
          {expandedAction ? (
            <div className="mt-1 flex justify-end">
              <Button
                variant="link"
                size="xs"
                onClick={expandedAction.onClick}
                className="h-auto px-0 text-[11px] font-normal text-muted-foreground underline underline-offset-2 hover:text-foreground"
              >
                {expandedAction.label}
              </Button>
            </div>
          ) : null}
        </div>
      )}

      {hasHighlights && (
        <div className="px-4 pt-3">
          <div className="rounded-lg bg-muted/60 px-3 py-2.5">
            <ul className="flex flex-col gap-1.5">
              {highlights.map((item, index) => (
                <li
                  key={`${index}-${item.headline}`}
                  className="flex gap-1.5 text-[11px] leading-4"
                >
                  <span
                    aria-hidden="true"
                    className="mt-[3px] size-1 shrink-0 rounded-full bg-muted-foreground/60"
                  />
                  <span className="min-w-0">
                    <span className="font-medium text-foreground">
                      {item.headline}
                    </span>
                    {item.detail ? (
                      <span className="text-muted-foreground">
                        {' '}
                        {item.detail}
                      </span>
                    ) : null}
                  </span>
                </li>
              ))}
            </ul>
            {remainingLabel ? (
              <div className="mt-1.5 pl-[10px] text-[11px] leading-4 text-muted-foreground">
                {remainingLabel}
              </div>
            ) : null}
          </div>
        </div>
      )}

      {/* Wraps rather than overflowing: three labels of unknown length share
          one row, and a longer translation would otherwise push "Update" off
          the card. When they do not fit, the action pair drops to its own
          right-aligned line and the link keeps the one above it. */}
      <div className="flex flex-wrap items-center justify-end gap-1 px-2 pb-2 pt-3">
        {secondaryAction ? (
          <Button
            variant="ghost"
            size="sm"
            onClick={secondaryAction.onClick}
            className="mr-auto min-w-0 max-w-full text-muted-foreground"
          >
            <span className="truncate">{secondaryAction.label}</span>
          </Button>
        ) : null}
        <div className="flex items-center gap-1">
          {dismissible ? (
            <Button variant="ghost" size="sm" onClick={onRemindLater}>
              {remindLaterLabel}
            </Button>
          ) : null}
          {busy && progress != null ? (
            <UpdateProgressButton
              progress={progress}
              label={busyLabel ?? updateLabel}
            />
          ) : (
            <Button size="sm" onClick={onUpdate} disabled={busy}>
              {busy ? (busyLabel ?? updateLabel) : updateLabel}
            </Button>
          )}
        </div>
      </div>
    </div>
  )

  // The Welcome cards establish their own stacking contexts. Rendering the
  // fixed banner beside them allowed a card border to paint over the banner.
  // The body is the app-wide overlay layer and keeps this notification above
  // route content regardless of which page is open.
  return typeof document === 'undefined'
    ? banner
    : createPortal(banner, document.body)
}

/**
 * The "Update" pill once pressed: the same size and shape, filling with the
 * primary colour as the update downloads. The label is drawn twice — muted on
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
      className="relative h-8 min-w-28 overflow-hidden rounded-full bg-primary/15 text-sm font-medium"
    >
      <div className={cn(labelClassName, 'text-foreground')}>{label}</div>
      <div
        aria-hidden="true"
        className={cn(
          labelClassName,
          'absolute inset-0 bg-primary text-primary-foreground transition-[clip-path] duration-300 ease-out'
        )}
        style={{ clipPath: `inset(0 ${100 - percent}% 0 0)` }}
      >
        {label}
      </div>
    </div>
  )
}

export default UpdateBanner
