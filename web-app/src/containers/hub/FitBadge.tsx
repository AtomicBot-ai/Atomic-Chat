import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  FIT_BADGE_CLASS,
  HARDWARE_FIT,
  type HardwareFit,
} from '@/lib/model-card'
import { cn } from '@/lib/utils'

export type FitBadgeProps = {
  fit: HardwareFit
  className?: string
}

/**
 * Compatibility badge for a download option: "Good fit" / "Should run" /
 * "Too large", with the same wording and palette the model cards have always
 * used. It states what the size means for *this* machine, which a claim about
 * GPU offload does not.
 */
export function FitBadge({ fit, className }: FitBadgeProps) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          className={cn(
            'inline-flex items-center justify-center whitespace-nowrap rounded-[6px] px-2.5 py-1 text-xs font-semibold',
            FIT_BADGE_CLASS[fit],
            className
          )}
        >
          {HARDWARE_FIT[fit].label}
        </span>
      </TooltipTrigger>
      <TooltipContent>
        <p>{HARDWARE_FIT[fit].tip}</p>
      </TooltipContent>
    </Tooltip>
  )
}
