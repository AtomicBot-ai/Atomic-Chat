import { CircleAlert, Info } from 'lucide-react'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'
import type { FitLevel } from '@/containers/SetupScreenHelpers'

/**
 * The small circled mark next to a model's name that says whether it fits
 * this machine's memory: green for "comfortably", yellow for "it will run,
 * expect less of it", red for "it will not load". The colour is never the
 * only signal — the warning colours change the glyph too, and the mark is a
 * button whose name reads the level and the reason, so it is reachable from
 * the keyboard and by a screen reader; the same sentence is its tooltip.
 */
const FIT_STYLE: Record<FitLevel, { Icon: typeof Info; className: string }> = {
  ok: { Icon: Info, className: 'text-emerald-600 dark:text-emerald-400' },
  warn: { Icon: CircleAlert, className: 'text-amber-500 dark:text-amber-400' },
  no: { Icon: CircleAlert, className: 'text-red-600 dark:text-red-400' },
}

export function ModelFitIndicator({
  level,
  label,
  reason,
  className,
}: {
  level: FitLevel
  /** Accessible name: the level's short label followed by `reason`. */
  label: string
  /** The sentence shown in the tooltip. */
  reason: string
  className?: string
}) {
  const { Icon, className: colour } = FIT_STYLE[level]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-fit={level}
          className={cn(
            'inline-flex size-4 shrink-0 cursor-default items-center justify-center rounded-full',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            colour,
            className
          )}
        >
          <Icon className="size-3.5" aria-hidden="true" />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64">
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}
