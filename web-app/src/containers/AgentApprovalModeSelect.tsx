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
  manualSelectedLabel: string
  manualLabel: string
  manualDescription: string
  skipSelectedLabel: string
  skipLabel: string
  skipDescription: string
}

export function AgentApprovalModeSelect({
  mode,
  onChange,
  manualSelectedLabel,
  manualLabel,
  manualDescription,
  skipSelectedLabel,
  skipLabel,
  skipDescription,
}: AgentApprovalModeSelectProps) {
  const selectedLabel =
    mode === 'manual' ? manualSelectedLabel : skipSelectedLabel

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={selectedLabel}
        >
          {mode === 'manual' ? (
            <Hand className="size-4" />
          ) : (
            <ShieldOff className="size-4" />
          )}
          <span>{selectedLabel}</span>
          <ChevronDown className="size-3.5" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-64 p-1">
        <DropdownMenuItem
          onSelect={() => onChange('manual')}
          className="items-start gap-2 px-2 py-2"
        >
          <Hand className="mt-0.5 size-4" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{manualLabel}</span>
            <span className="block text-xs leading-4 text-muted-foreground">
              {manualDescription}
            </span>
          </span>
          <Check
            className={cn(
              'mt-0.5 size-4 text-primary',
              mode !== 'manual' && 'invisible'
            )}
          />
        </DropdownMenuItem>
        <DropdownMenuItem
          onSelect={() => onChange('skip')}
          className="items-start gap-2 px-2 py-2"
        >
          <ShieldOff className="mt-0.5 size-4" />
          <span className="min-w-0 flex-1">
            <span className="block text-sm font-medium">{skipLabel}</span>
            <span className="block text-xs leading-4 text-muted-foreground">
              {skipDescription}
            </span>
          </span>
          <Check
            className={cn(
              'mt-0.5 size-4 text-primary',
              mode !== 'skip' && 'invisible'
            )}
          />
        </DropdownMenuItem>
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
