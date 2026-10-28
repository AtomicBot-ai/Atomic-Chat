import { useRef, useState, type ReactElement } from 'react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatRowActivity } from '@/lib/sidebar-row-names'

/** About a native tooltip's wait, so sweeping down the list stays quiet. */
const OPEN_DELAY_MS = 500

/**
 * A sidebar row's full name, with when it was last active, on hover and on
 * keyboard focus. It only opens for a row that cuts its name short (its
 * `[data-row-name]` element overflows) or, with `always`, for a row whose
 * name collides with another row's.
 */
export function NavRowTooltip({
  name,
  lastActivity,
  always = false,
  children,
}: {
  name: string
  /** Epoch milliseconds. */
  lastActivity?: number
  always?: boolean
  /** The row's link; it becomes the tooltip's trigger. */
  children: ReactElement
}) {
  const { t, i18n } = useTranslation()
  const [open, setOpen] = useState(false)
  // Radix types the trigger as a button; here it is the row's link, and only
  // its descendants are read.
  const triggerRef = useRef<HTMLButtonElement>(null)

  const handleOpenChange = (next: boolean) => {
    if (!next) {
      setOpen(false)
      return
    }
    const label =
      triggerRef.current?.querySelector<HTMLElement>('[data-row-name]')
    setOpen(always || (!!label && label.scrollWidth > label.clientWidth))
  }

  return (
    <Tooltip
      delayDuration={OPEN_DELAY_MS}
      open={open}
      onOpenChange={handleOpenChange}
    >
      <TooltipTrigger asChild ref={triggerRef}>
        {children}
      </TooltipTrigger>
      <TooltipContent
        side="right"
        sideOffset={8}
        className="max-w-72 text-left break-words"
      >
        <span className="block font-medium">{name}</span>
        {lastActivity !== undefined && (
          <span className="mt-0.5 block opacity-70">
            {t('common:navigation.lastActivity', {
              date: formatRowActivity(lastActivity, i18n?.language).full,
            })}
          </span>
        )}
      </TooltipContent>
    </Tooltip>
  )
}

/**
 * The context a colliding row carries after its name: when it was last
 * active, short enough to keep the row on one line. It shows only in a
 * sidebar widened past the default, where the name keeps its room; a
 * narrower one leaves the date to the row's tooltip.
 */
export function NavRowActivity({ at }: { at: number }) {
  const { i18n } = useTranslation()
  const { short, iso } = formatRowActivity(at, i18n?.language)
  return (
    <time
      dateTime={iso}
      className="hidden shrink-0 text-xs font-normal tabular-nums text-muted-foreground @min-[18rem]/sidebar:inline"
    >
      {short}
    </time>
  )
}
