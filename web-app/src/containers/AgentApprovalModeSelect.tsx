import { Check, ChevronDown, Hand, ShieldOff } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AgentApprovalMode } from '@/hooks/useAgentMode'

type AgentApprovalModeSelectProps = {
  mode: AgentApprovalMode
  onChange: (mode: AgentApprovalMode) => void
  manualLabel: string
  manualDescription: string
  skipLabel: string
  skipDescription: string
}

export function AgentApprovalModeSelect({
  mode,
  onChange,
  manualLabel,
  manualDescription,
  skipLabel,
  skipDescription,
}: AgentApprovalModeSelectProps) {
  const selectedLabel = mode === 'manual' ? manualLabel : skipLabel

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex items-center gap-1 rounded-md px-1.5 py-0.5 text-[11px] text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={selectedLabel}
        >
          {mode === 'manual' ? (
            <Hand className="size-3" />
          ) : (
            <ShieldOff className="size-3" />
          )}
          <span>{selectedLabel}</span>
          <ChevronDown className="size-2.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-1">
        <DropdownMenuItem
          onSelect={() => onChange('manual')}
          className="items-start gap-2 px-2 py-1.5"
        >
          <Hand className="mt-0.5 size-3.5" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">{manualLabel}</span>
            <span className="block text-[11px] leading-3.5 text-muted-foreground">
              {manualDescription}
            </span>
          </span>
          <Check
            className={cn(
              'mt-0.5 size-3.5 text-primary',
              mode !== 'manual' && 'invisible'
            )}
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onChange('skip')}
          className="items-start gap-2 px-2 py-1.5"
        >
          <ShieldOff className="mt-0.5 size-3.5" />
          <span className="min-w-0 flex-1">
            <span className="block text-xs font-medium">{skipLabel}</span>
            <span className="block text-[11px] leading-3.5 text-muted-foreground">
              {skipDescription}
            </span>
          </span>
          <Check
            className={cn(
              'mt-0.5 size-3.5 text-primary',
              mode !== 'skip' && 'invisible'
            )}
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
