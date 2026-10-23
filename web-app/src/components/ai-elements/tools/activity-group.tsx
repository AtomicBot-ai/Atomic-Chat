import { CircleAlert, Loader2 } from 'lucide-react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { TraceBlock } from '@/lib/tools/types'
import { ToolRenderer } from './tool-renderer'

type ActivityTool = Extract<TraceBlock, { kind: 'activity' }>['tools'][number]

type ToolActivityGroupProps = {
  tools: ActivityTool[]
  errorMessage?: string
  active?: boolean
  /** Permission and folder-access waits are not tool execution. */
  working?: boolean
  onRetry?: () => void
}

/** Each call owns one row and one disclosure for its parameters and output. */
export function ToolActivityGroup({
  tools,
  errorMessage,
  active = false,
  working = false,
  onRetry,
}: ToolActivityGroupProps) {
  const { t } = useTranslation('chat')
  return (
    <div className="not-prose min-w-0" data-testid="tool-activity-group">
      {tools.map((tool) => (
        <ToolRenderer
          key={tool.key}
          toolName={tool.toolName}
          presentation={tool.presentation}
          state={tool.state}
          active={active}
          waiting={working}
          onRetry={onRetry}
        />
      ))}
      {tools.length === 0 && active && (
        <div
          role="status"
          className="flex min-h-6 items-center gap-2 py-1 text-sm text-muted-foreground"
        >
          <Loader2
            aria-hidden="true"
            className="size-[18px] shrink-0 animate-spin"
          />
          <span>{t('activity.working')}</span>
        </div>
      )}
      {errorMessage && (
        <div
          role="alert"
          className="flex items-center gap-2 py-1 text-sm text-destructive"
        >
          <CircleAlert aria-hidden="true" className="size-[18px] shrink-0" />
          <span className="min-w-0 break-words">{errorMessage}</span>
        </div>
      )}
    </div>
  )
}
