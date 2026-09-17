import type { ReactNode } from 'react'

import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'

/**
 * A hover the eye can catch on a secondary row button in the dark theme:
 * `secondary`'s own `hover:bg-secondary/80` moves the fill by a fifth of a
 * shade towards the card behind it, which on a card is no move at all. The
 * light theme gets its visible rest and hover fills from the variant itself.
 */
export const ROUTE_ROW_BUTTON_HOVER =
  'transition-colors dark:hover:bg-neutral-600'

/**
 * The classes every action button in a model or route list shares, so the
 * buttons of one list read as one column whatever their labels say. A row
 * that draws its own button (the onboarding's model rows) uses this too.
 */
export const ROUTE_ROW_ACTION_CLASS = 'shrink-0 rounded-full px-4'

type RouteRowProps = {
  'icon': ReactNode
  'title': string
  /** Optional mark beside the title: a recommended model's fit badge. */
  'meta'?: ReactNode
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
  'data-testid'?: string
}

/**
 * A way to get a model, laid out as a model row — mark, name, one line,
 * button — so a list of routes reads as one list, whatever the route is:
 * onboarding's cloud rows, the composer's "what do I reply with?" widget, or
 * a recommended download beside them.
 *
 * The title is not a heading: these rows sit under a dialog's own title or
 * an onboarding section label, and a list of h2s reads as an outline to a
 * screen reader.
 */
export function RouteRow({
  icon,
  title,
  meta,
  hint,
  action,
  label,
  onClick,
  disabled = false,
  primary = false,
  'data-testid': testId,
}: RouteRowProps) {
  return (
    <div
      className="flex items-center justify-between gap-3 py-2.5 first:pt-0 last:pb-0"
      data-testid={testId}
    >
      <div className="flex min-w-0 flex-1 items-center gap-3">
        {/* Direct children only: a `ModelLogo` in this slot sizes its own
            image, and an inherited 16 px would shrink its mark to a dot. */}
        <span
          aria-hidden="true"
          className="flex size-8 shrink-0 items-center justify-center overflow-hidden rounded-full bg-secondary text-foreground [&>svg]:size-4 [&>img]:size-4"
        >
          {icon}
        </span>
        <div className="min-w-0 flex-1">
          <span className="flex min-w-0 items-center gap-2">
            <span className="block min-w-0 truncate text-sm font-medium leading-tight">
              {title}
            </span>
            {meta}
          </span>
          <span className="mt-0.5 line-clamp-1 block text-xs text-muted-foreground">
            {hint}
          </span>
        </div>
      </div>
      <Button
        type="button"
        variant={primary ? 'default' : 'secondary'}
        size="sm"
        aria-label={label}
        disabled={disabled}
        onClick={onClick}
        className={cn(ROUTE_ROW_ACTION_CLASS, !primary && ROUTE_ROW_BUTTON_HOVER)}
      >
        {action}
      </Button>
    </div>
  )
}
