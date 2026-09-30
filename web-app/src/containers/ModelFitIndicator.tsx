import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { FitLevel } from '@/containers/SetupScreenHelpers'

/**
 * The small badge beside a model's name that says whether it fits this
 * machine's memory: a verdict — Good fit, Might fit, Won't fit — on a green, amber or
 * red pill, in the style of the source badges the rows found on disk wear.
 * The colour is never the only signal, since the word changes with it. The
 * badge is a button whose accessible name reads the level's full label and
 * the reason, so it is reachable from the keyboard and by a screen reader;
 * the reason alone is its tooltip.
 *
 * It was a circled glyph. The marks drifted out of line from row to row, and
 * a glyph says nothing until it is hovered.
 */
const FIT_STYLE: Record<FitLevel, { textKey: string; className: string }> = {
  ok: {
    textKey: 'setup:recommend.fitBadgeOk',
    className:
      'border-emerald-200 bg-emerald-50 text-emerald-800 dark:border-emerald-800 dark:bg-emerald-950/45 dark:text-emerald-200',
  },
  warn: {
    textKey: 'setup:recommend.fitBadgeWarn',
    className:
      'border-amber-200 bg-amber-50 text-amber-800 dark:border-amber-800 dark:bg-amber-950/45 dark:text-amber-200',
  },
  no: {
    textKey: 'setup:recommend.fitBadgeNo',
    className:
      'border-red-200 bg-red-50 text-red-700 dark:border-red-900 dark:bg-red-950/45 dark:text-red-300',
  },
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
  const { t } = useTranslation()
  const { textKey, className: colour } = FIT_STYLE[level]
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          aria-label={label}
          data-fit={level}
          className={cn(
            'inline-block shrink-0 cursor-default whitespace-nowrap rounded-[6px] border px-1.5 py-0.5 text-[10px] font-semibold leading-tight',
            'focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
            colour,
            className
          )}
        >
          <span className="inline-block">{t(textKey)}</span>
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-52 px-2.5 text-left text-pretty">
        {reason}
      </TooltipContent>
    </Tooltip>
  )
}
