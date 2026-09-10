import type { ReactNode } from 'react'

import { cn } from '@/lib/utils'

type VoiceSetupRowProps = {
  /**
   * The 40px square on the left: an icon tile (`VoiceSetupRowIcon`) or a logo
   * that draws its own tile, like `ModelLogo`.
   */
  media: ReactNode
  title: ReactNode
  description?: ReactNode
  /** Right-hand slot: a button, or the state the row is already in. */
  action?: ReactNode
  /** Extra block under the row, ruled off — the denied-permission help. */
  footer?: ReactNode
  className?: string
}

/**
 * The one row shape the setup wizard uses for a prerequisite.
 *
 * Microphone access and the voice model are the same kind of thing to the user
 * — "something that has to be in place before dictation works" — so they get
 * the same object on screen: logo, name, one line of explanation, and the
 * control on the right. Sharing the shape is what keeps steps 2 and 3 aligned
 * with each other instead of each inventing its own block.
 */
export function VoiceSetupRow({
  media,
  title,
  description,
  action,
  footer,
  className,
}: VoiceSetupRowProps) {
  return (
    <div className={cn('rounded-xl border bg-secondary/40 p-3', className)}>
      <div className="flex items-center gap-3">
        {media}
        <div className="min-w-0 flex-1">
          <p className="truncate text-sm font-medium leading-tight">{title}</p>
          {description && (
            <p className="mt-1 text-xs leading-snug text-muted-foreground">
              {description}
            </p>
          )}
        </div>
        {action && <div className="shrink-0">{action}</div>}
      </div>
      {footer && <div className="mt-3 border-t pt-3">{footer}</div>}
    </div>
  )
}

/**
 * Square tile for rows whose media is a plain icon rather than a logo. `sm` is
 * for the intro bullets, which are a list rather than a prerequisite row.
 */
export function VoiceSetupRowIcon({
  children,
  size = 'default',
}: {
  children: ReactNode
  size?: 'default' | 'sm'
}) {
  return (
    <div
      className={cn(
        'grid shrink-0 place-items-center rounded-lg border bg-background text-muted-foreground',
        size === 'sm' ? 'size-8' : 'size-10'
      )}
    >
      {children}
    </div>
  )
}
