import { memo, type ReactNode } from 'react'
import { IconInfoCircle } from '@tabler/icons-react'

import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { cn } from '@/lib/utils'

type ImageFieldProps = {
  label: ReactNode
  /** `htmlFor` of the label; omit when the control is not a single input. */
  htmlFor?: string
  /** A sentence behind an (i) icon: what the control does, not its name again. */
  hint?: ReactNode
  /** Something on the far right of the label row, e.g. the size readout. */
  trailing?: ReactNode
  className?: string
  children: ReactNode
}

/**
 * One labelled row of the Images form: a muted small label, an optional hint
 * and the control underneath. Every field on the page goes through this so
 * the labels line up and the spacing is one number.
 */
export const ImageField = memo(function ImageField({
  label,
  htmlFor,
  hint,
  trailing,
  className,
  children,
}: ImageFieldProps) {
  return (
    <div className={cn('flex flex-col gap-1.5', className)}>
      <div className="flex items-center gap-1">
        <label
          htmlFor={htmlFor}
          className="text-xs font-medium text-muted-foreground"
        >
          {label}
        </label>
        {hint && <ImageFieldHint>{hint}</ImageFieldHint>}
        {trailing && <div className="ml-auto">{trailing}</div>}
      </div>
      {children}
    </div>
  )
})

/** The (i) beside a label. */
export function ImageFieldHint({ children }: { children: ReactNode }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <button
          type="button"
          tabIndex={-1}
          aria-hidden
          className="inline-flex cursor-help text-muted-foreground/70 hover:text-foreground"
        >
          <IconInfoCircle size={13} />
        </button>
      </TooltipTrigger>
      <TooltipContent side="top" className="max-w-64 text-xs leading-snug">
        {children}
      </TooltipContent>
    </Tooltip>
  )
}

export default ImageField
