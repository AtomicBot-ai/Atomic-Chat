import { cn } from '@/lib/utils'

type ChatAgentModeSwitchProps = {
  isAgentMode: boolean
  onChange: (isAgentMode: boolean) => void
  chatLabel: string
  agentLabel: string
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

        return (
          <button
            key={mode.label}
            type="button"
            aria-pressed={isActive}
            onClick={() => onChange(mode.value)}
            className={cn(
              'rounded-md px-2.5 py-1 text-xs font-medium text-muted-foreground transition-colors focus-visible:outline-none focus-visible:ring-2 focus-visible:ring-ring',
              isActive &&
                'bg-background text-foreground shadow-sm dark:bg-secondary'
            )}
          >
            {mode.label}
          </button>
        )
      })}
    </div>
  )
}
