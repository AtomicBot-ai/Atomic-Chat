import { cn } from '@/lib/utils'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'

type ChatAgentModeSwitchProps = {
  isAgentMode: boolean
  onChange: (isAgentMode: boolean) => void
  chatLabel: string
  agentLabel: string
  agentDisabled?: boolean
  agentDisabledTooltip?: string
}

export function canSelectChatAgentMode(
  initialMessage: boolean | undefined,
  projectId: string | undefined
): boolean {
  return Boolean(initialMessage && !projectId)
}

export function ChatAgentModeSwitch({
  isAgentMode,
  onChange,
  chatLabel,
  agentLabel,
  agentDisabled = false,
  agentDisabledTooltip,
}: ChatAgentModeSwitchProps) {
  return (
    <div
      className="flex items-center rounded-lg bg-muted/70 p-0.5"
      role="group"
      aria-label={`${chatLabel} / ${agentLabel}`}
    >
      {[
        { label: chatLabel, value: false },
        { label: agentLabel, value: true },
      ].map((mode) => {
        const isActive = isAgentMode === mode.value
        const isDisabled = mode.value && agentDisabled

        const button = (
          <button
            key={mode.label}
            type="button"
            aria-pressed={isActive}
            disabled={isDisabled}
            onClick={() => onChange(mode.value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive &&
                'bg-background text-foreground shadow-sm dark:bg-secondary',
              isDisabled && 'cursor-not-allowed opacity-50'
            )}
          >
            {mode.label}
          </button>
        )

        if (!isDisabled || !agentDisabledTooltip) return button

        return (
          <Tooltip key={mode.label}>
            <TooltipTrigger asChild>
              <span
                className="inline-flex cursor-not-allowed"
                title={agentDisabledTooltip}
              >
                {button}
              </span>
            </TooltipTrigger>
            <TooltipContent>{agentDisabledTooltip}</TooltipContent>
          </Tooltip>
        )
      })}
    </div>
  )
}
