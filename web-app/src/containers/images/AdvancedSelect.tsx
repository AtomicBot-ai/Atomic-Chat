import type { ReactNode } from 'react'
import { IconChevronDown } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import { ImageFieldHint } from './ImageField'

type AdvancedSelectProps<T extends string | number> = {
  label: string
  hint?: ReactNode
  value: T
  options: Array<[T, string]>
  disabled?: boolean
  onChange: (value: T) => void
}

/** One Advanced row: a muted label on the left, a pill menu on the right. Shared with the Video form. */
export function AdvancedSelect<T extends string | number>({
  label,
  hint,
  value,
  options,
  disabled,
  onChange,
}: AdvancedSelectProps<T>) {
  const current =
    options.find(([option]) => option === value)?.[1] ?? String(value)
  return (
    <div className="flex items-center justify-between gap-3">
      <span className="flex min-w-0 items-center gap-1 text-xs font-medium text-muted-foreground">
        <span className="truncate">{label}</span>
        {hint && <ImageFieldHint>{hint}</ImageFieldHint>}
      </span>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="h-8 w-40 shrink-0 justify-between text-xs font-normal"
            disabled={disabled}
            aria-label={label}
          >
            <span className="truncate">{current}</span>
            <IconChevronDown
              size={16}
              className="shrink-0 text-muted-foreground"
            />
          </Button>
        </DropdownMenuTrigger>
        <DropdownMenuContent align="end" className="w-40">
          {options.map(([option, text]) => (
            <DropdownMenuItem
              key={String(option)}
              className={cn(
                'cursor-pointer text-xs',
                option === value && 'bg-secondary-foreground/8'
              )}
              onClick={() => onChange(option)}
            >
              {text}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}
