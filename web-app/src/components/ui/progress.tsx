import * as React from 'react'
import * as ProgressPrimitive from '@radix-ui/react-progress'

import { cn } from '@/lib/utils'

type ProgressProps = React.ComponentProps<typeof ProgressPrimitive.Root> & {
  //* Indicator class (primary by default); for downloads — semi-transparent green, etc.
  indicatorClassName?: string
}

/**
 * The value Radix reports as `aria-valuenow`: a number in `0..max`, or `null`
 * (indeterminate) when there is none. Radix rejects anything out of range
 * with a console error, so clamp rather than drop a slight overshoot.
 */
function accessibleValue(
  value: number | null | undefined,
  max: number | undefined
): number | null {
  if (typeof value !== 'number' || !Number.isFinite(value)) return null
  const upper = typeof max === 'number' && max > 0 ? max : 100
  return Math.min(Math.max(value, 0), upper)
}

function Progress({
  className,
  value,
  indicatorClassName,
  ...props
}: ProgressProps) {
  return (
    <ProgressPrimitive.Root
      data-slot="progress"
      className={cn(
        'bg-secondary relative h-2 w-full overflow-hidden rounded-full',
        className
      )}
      {...props}
      // Without a value Radix renders an indeterminate progressbar, which
      // macOS accessibility reads as a constant 50 whatever the bar shows.
      value={accessibleValue(value, props.max)}
    >
      <ProgressPrimitive.Indicator
        data-slot="progress-indicator"
        className={cn(
          'h-full w-full flex-1 transition-all bg-primary',
          indicatorClassName
        )}
        style={{ transform: `translateX(-${100 - (value || 0)}%)` }}
      />
    </ProgressPrimitive.Root>
  )
}

export { Progress }
