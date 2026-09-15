import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A hover the eye can catch on a secondary row button. `secondary`'s own
 * `hover:bg-secondary/80` moves the fill by a fifth of a shade towards the
 * card behind it, which on a card is no move at all.
 */
export const ROUTE_ROW_BUTTON_HOVER =
  'transition-colors hover:bg-neutral-200 dark:hover:bg-neutral-600'

type RouteRowProps = {
  'icon': ReactNode
  'title': string
  'hint': string
  /** What the button shows: the verb alone, or a width-reserving label. */
  'action': ReactNode
  /**
   * The whole action, for assistive tech. The button shows only the verb, and
   * "Add" alone says nothing to a screen reader.
   */
  'label': string
  'onClick': () => void
  'disabled'?: boolean
  /** The row the screen leads with: filled button instead of a secondary. */
  'primary'?: boolean
  /** Reserved for a badge or a second line under the title. */
  'children'?: ReactNode
  'data-testid'?: string
}

/**
 * A way to get a model, laid out as a model row — mark, name, one line,
 * button — so a list of routes reads as one list, whatever the route is:
 * onboarding's cloud rows, the composer's "what do I reply with?" widget, or
 * a recommended download beside them.
 */
export function RouteRow({
  icon,
  title,
  hint,
  action,
  label,
  onClick,
  disabled = false,
  primary = false,
  children,
  'data-testid': testId,
}: RouteRowProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-foreground [&_svg]:size-4 [&_img]:size-4"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2 className="truncate text-sm font-medium leading-tight">
              {title}
            </h2>
            {children}
          </div>
          <p className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {hint}
          </p>
        </div>
      </div>
      <Button
        type="button"
        variant={primary ? 'default' : 'secondary'}
        size="sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(
          'shrink-0 rounded-full px-4',
          !primary && ROUTE_ROW_BUTTON_HOVER
        )}
      >
        {action}
      </Button>
    </div>
  )
}
