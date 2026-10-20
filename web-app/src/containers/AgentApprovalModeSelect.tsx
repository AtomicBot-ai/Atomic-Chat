import type { LucideIcon } from 'lucide-react'
import { useState, type ReactNode } from 'react'
import { Check, ChevronDown, CircleAlert, Hand } from 'lucide-react'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuLabel,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { cn } from '@/lib/utils'
import type { AgentApprovalMode } from '@/hooks/useAgentMode'

/**
 * An on/off switch that rides the access menu under the approval modes: what
 * the model may do at all (the agent loop), next to how its calls are
 * approved.
 */
export type ApprovalMenuToggle = {
  id: string
  label: string
  description?: string
  icon: ReactNode
  checked: boolean
  onCheckedChange: (checked: boolean) => void
  testId?: string
}

type AgentApprovalModeSelectProps = {
  compact?: boolean
  mode: AgentApprovalMode
  onChange: (mode: AgentApprovalMode) => void
  menuTitle: string
  manualSelectedLabel: string
  manualLabel: string
  manualDescription: string
  skipSelectedLabel: string
  skipLabel: string
  skipDescription: string
  skipConfirmTitle: string
  skipConfirmBody: string
  skipConfirmCancel: string
  skipConfirmAccept: string
  toggles?: ApprovalMenuToggle[]
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
  compact = false,
  mode,
  onChange,
  menuTitle,
  manualSelectedLabel,
  manualLabel,
  manualDescription,
  skipSelectedLabel,
  skipLabel,
  skipDescription,
  skipConfirmTitle,
  skipConfirmBody,
  skipConfirmCancel,
  skipConfirmAccept,
  toggles = [],
}: AgentApprovalModeSelectProps) {
  // Picking Full access asks first, every time: the mode only changes from
  // the dialog's accept button, and Cancel / Escape leave it as it was.
  const [confirmSkipOpen, setConfirmSkipOpen] = useState(false)
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

  const handleSelect = (value: AgentApprovalMode) => {
    if (value === 'skip') {
      setConfirmSkipOpen(true)
      return
    }
    onChange(value)
  }

  const handleConfirmSkip = () => {
    setConfirmSkipOpen(false)
    onChange('skip')
  }

  return (
    <>
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            className={cn(
              'flex shrink-0 cursor-pointer items-center rounded-md py-0.5 text-sm whitespace-nowrap text-muted-foreground transition-colors hover:bg-muted hover:text-foreground focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring data-[state=open]:bg-muted data-[state=open]:text-foreground',
              compact ? 'px-1' : 'gap-1.5 px-1.5'
            )}
            aria-label={selectedLabel}
          >
            <SelectedIcon className="size-4" />
            {/* The label stays in the compact composer too: an icon alone
                did not say which mode the next tool call runs under. */}
            <span className={cn(compact && 'ml-1.5')}>{selectedLabel}</span>
            <ChevronDown className="size-3.5 opacity-60" />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          collisionPadding={16}
          className="w-[26rem] max-w-[calc(100vw-2rem)] p-1"
        >
          <DropdownMenuLabel className="px-2 pt-1.5 pb-1 text-xs font-normal text-muted-foreground">
            {menuTitle}
          </DropdownMenuLabel>
          {options.map((option) => {
            const Icon = MODE_ICONS[option.value]
            const selected = mode === option.value
            return (
              // The item's own `items-center` keeps the icon and the checkmark
              // on the middle of the title + description block. Pinned to the
              // title line they sat at the top of the three-line Full access
              // row and read as "flown up".
              <DropdownMenuItem
                key={option.value}
                onSelect={() => handleSelect(option.value)}
                className="gap-2.5 px-2 py-2"
              >
                <Icon className="size-4 text-muted-foreground" />
                <span className="min-w-0 flex-1">
                  <span className="block text-sm">{option.label}</span>
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {option.description}
                  </span>
                </span>
                <Check
                  className={cn(
                    'size-4 text-foreground',
                    !selected && 'invisible'
                  )}
                />
              </DropdownMenuItem>
            )
          })}
          {toggles.length > 0 && <DropdownMenuSeparator />}
          {toggles.map((toggle) => (
            <DropdownMenuItem
              key={toggle.id}
              role="menuitemcheckbox"
              aria-checked={toggle.checked}
              data-testid={toggle.testId}
              onSelect={() => toggle.onCheckedChange(!toggle.checked)}
              className="gap-2.5 px-2 py-2"
            >
              {toggle.icon}
              <span className="min-w-0 flex-1">
                <span className="block text-sm">{toggle.label}</span>
                {toggle.description && (
                  <span className="mt-0.5 block text-xs leading-4 text-muted-foreground">
                    {toggle.description}
                  </span>
                )}
              </span>
              {/* Drawn like the app's Switch, but inert: the whole row is the
                  control, and a button inside a menu item would be a second
                  focus stop for the same action. */}
              <span
                aria-hidden
                data-state={toggle.checked ? 'checked' : 'unchecked'}
                className="inline-flex h-[18px] w-8.5 shrink-0 items-center rounded-full border shadow-xs transition-colors motion-reduce:transition-none data-[state=checked]:bg-primary data-[state=unchecked]:bg-input"
              >
                <span
                  data-state={toggle.checked ? 'checked' : 'unchecked'}
                  className="block size-4 rounded-full bg-background transition-transform motion-reduce:transition-none data-[state=checked]:translate-x-full"
                />
              </span>
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
      <Dialog open={confirmSkipOpen} onOpenChange={setConfirmSkipOpen}>
        {/* Wide enough for the warning to stay two lines at the default and
            Large font settings; the default width wrapped it to four. */}
        <DialogContent className="sm:max-w-xl lg:max-w-xl xl:max-w-xl">
          <DialogHeader>
            <DialogTitle>{skipConfirmTitle}</DialogTitle>
            <DialogDescription>{skipConfirmBody}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <DialogClose asChild>
              <Button variant="ghost" size="sm" className="w-full sm:w-auto">
                {skipConfirmCancel}
              </Button>
            </DialogClose>
            <Button
              size="sm"
              className="w-full sm:w-auto"
              onClick={handleConfirmSkip}
            >
              {skipConfirmAccept}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </>
  )
}
