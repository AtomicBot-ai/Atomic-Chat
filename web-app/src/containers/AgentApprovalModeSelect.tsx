import type { LucideIcon } from 'lucide-react'
import { Check, ChevronDown, CircleAlert, Hand } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { cn } from '@/lib/utils'
import type { AgentApprovalMode } from '@/hooks/useAgentMode'

type AgentApprovalModeSelectProps = {
  mode: AgentApprovalMode
  onChange: (mode: AgentApprovalMode) => void
  menuTitle: string
  manualSelectedLabel: string
  manualLabel: string
  manualDescription: string
  skipSelectedLabel: string
  skipLabel: string
  skipDescription: string
}

/**
 * Full access is told apart by its icon and its words, not by colour. It used
 * to paint the whole row and the composer trigger red, which read as an error
 * rather than a choice and scared people off a mode that is theirs to pick;
 * an amber icon still singled it out as a warning.
 */
const MODE_ICONS: Record<AgentApprovalMode, LucideIcon> = {
  manual: Hand,
  skip: CircleAlert,
}

export function AgentApprovalModeSelect({
  mode,
  onChange,
  menuTitle,
  manualSelectedLabel,
  manualLabel,
  manualDescription,
  skipSelectedLabel,
  skipLabel,
  skipDescription,
}: AgentApprovalModeSelectProps) {
  const selectedLabel =
    mode === 'manual' ? manualSelectedLabel : skipSelectedLabel
  const SelectedIcon = MODE_ICONS[mode]
  const options: Array<{
    value: AgentApprovalMode
    label: string
    description: string
  }> = [
    { value: 'manual', label: manualLabel, description: manualDescription },
    { value: 'skip', label: skipLabel, description: skipDescription },
  ]

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          className="flex shrink-0 cursor-pointer items-center gap-1.5 rounded-md px-1.5 py-0.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground"
          aria-label={selectedLabel}
        >
          <SelectedIcon className="size-4" />
          <span>{selectedLabel}</span>
          <ChevronDown className="size-3.5 opacity-60" />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent align="start" className="w-80 p-1">
        <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-xs font-normal text-muted-foreground">
          {menuTitle}
        </DropdownMenuLabel>
        {options.map((option) => {
          const Icon = MODE_ICONS[option.value]
          const selected = mode === option.value
          return (
            <DropdownMenuItem
              key={option.value}
              onSelect={() => onChange(option.value)}
              className="items-start gap-2.5 px-2 py-2"
            >
              <Icon className="mt-0.5 size-4 text-muted-foreground" />
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{option.label}</span>
                <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                  {option.description}
                </span>
              </span>
              <Check
                className={cn(
                  'mt-0.5 size-4 text-foreground',
                  !selected && 'invisible'
                )}
              />
            </DropdownMenuItem>
          )
        })}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}
