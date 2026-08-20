import { useState, type ReactNode } from 'react'
import { ChevronDownIcon } from 'lucide-react'
import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { Shimmer } from '@/components/ai-elements/shimmer'
import { cn } from '@/lib/utils'

type AgentActivityProps = {
  active: boolean
  durationLabel: string
  workingLabel: string
  hasDetails?: boolean
  className?: string
  children: ReactNode
}

export function AgentActivity({
  active,
  durationLabel,
  workingLabel,
  hasDetails = true,
  className,
  children,
}: AgentActivityProps) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible
      open={open}
      onOpenChange={setOpen}
      className={cn('not-prose mb-3 text-sm text-muted-foreground', className)}
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className={cn(
          'flex items-center gap-1.5 py-0.5 transition-colors',
          hasDetails
            ? 'hover:text-foreground'
            : 'cursor-default hover:text-muted-foreground'
        )}
      >
        {active ? (
          <Shimmer duration={1}>{workingLabel}</Shimmer>
        ) : (
          <span>{durationLabel}</span>
        )}
        {hasDetails && (
          <ChevronDownIcon
            className={cn(
              'size-3.5 transition-transform',
              open && 'rotate-180'
            )}
          />
        )}
      </CollapsibleTrigger>
      {hasDetails && (
        <CollapsibleContent className="mt-2 space-y-1 border-l border-border/60 pl-3">
          {children}
        </CollapsibleContent>
      )}
    </Collapsible>
  )
}

type ActivityDetailProps = {
  label: string
  children: ReactNode
}

export function ActivityDetail({ label, children }: ActivityDetailProps) {
  const [open, setOpen] = useState(false)

  return (
    <Collapsible open={open} onOpenChange={setOpen}>
      <CollapsibleTrigger className="flex items-center gap-1.5 py-1 text-left transition-colors hover:text-foreground">
        <ChevronDownIcon
          className={cn('size-3.5 transition-transform', open && 'rotate-90')}
        />
        <span>{label}</span>
      </CollapsibleTrigger>
      <CollapsibleContent className="space-y-2 pb-2 pl-5 pt-1">
        {children}
      </CollapsibleContent>
    </Collapsible>
  )
}
