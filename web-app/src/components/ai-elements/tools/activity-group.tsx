import { useState } from 'react'
import { CircleAlert, ChevronRight, ListChecks } from 'lucide-react'

import { Collapsible, CollapsibleContent, CollapsibleTrigger } from '@/components/ui/collapsible'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toolActivityLabel } from '@/lib/tools/activity-label'
import type { TraceBlock } from '@/lib/tools/types'
import { cn } from '@/lib/utils'
import { ToolRenderer } from './tool-renderer'
import { Shimmer } from '@/components/ai-elements/shimmer'

type ActivityTool = Extract<TraceBlock, { kind: 'activity' }>['tools'][number]

type ToolActivityGroupProps = {
  tools: ActivityTool[]
  loopMessages?: string[]
  errorMessage?: string
  working?: boolean
  onRetry?: () => void
}

const isRunning = (tool: ActivityTool) =>
  tool.state === 'input-streaming' || tool.state === 'input-available'

/**
 * One turn-level activity disclosure containing individually inspectable tool
 * calls. The headline follows the live call, then settles into a compact list
 * of completed action kinds. Each child keeps its own second disclosure for
 * parameters and output.
 */
export function ToolActivityGroup({
  tools,
  loopMessages = [],
  errorMessage,
  working = false,
  onRetry,
}: ToolActivityGroupProps) {
  const { t } = useTranslation('chat')
  const runningTool = tools.find(isRunning)
  const live = Boolean(runningTool || working)
  // A live turn stays one stable row. The user can opt into the detailed
  // timeline, but new tool calls never expand it and shove the answer around.
  const [open, setOpen] = useState(false)

  const summary = runningTool
    ? toolActivityLabel(
        runningTool.toolName,
        runningTool.presentation,
        runningTool.state,
        t
      )
    : working
      ? t('activity.working')
      : errorMessage
        ? errorMessage
        : tools.length > 1
          ? t('activity.completedActions', { count: tools.length })
          : tools.length === 1
            ? toolActivityLabel(
                tools[0].toolName,
                tools[0].presentation,
                tools[0].state,
                t
              )
            : t('activity.working')

  const hasDetails =
    tools.length > 0 || loopMessages.length > 0 || Boolean(errorMessage)
  const StatusIcon = errorMessage ? CircleAlert : ListChecks

  return (
    <Collapsible
      open={hasDetails ? open : false}
      onOpenChange={hasDetails ? setOpen : undefined}
      className="group/activity not-prose"
      data-testid="tool-activity-group"
    >
      <CollapsibleTrigger
        disabled={!hasDetails}
        className="flex min-h-6 w-full min-w-0 items-center gap-2 rounded-sm py-1 text-left text-sm text-muted-foreground transition-colors hover:text-foreground disabled:cursor-default disabled:hover:text-muted-foreground"
      >
        <StatusIcon
          aria-hidden="true"
          className={cn(
            'size-[18px] shrink-0',
            errorMessage && !live && 'text-destructive'
          )}
        />
        <span className="min-w-0 flex-1 truncate">
          {live ? <Shimmer duration={2}>{summary}</Shimmer> : summary}
        </span>
        {hasDetails && (
          <ChevronRight
            aria-hidden="true"
            className="size-3.5 shrink-0 transition-transform group-data-[state=open]/activity:rotate-90"
          />
        )}
      </CollapsibleTrigger>

      <CollapsibleContent className="relative pb-1 pt-0.5">
        <div className="ml-1.5 border-l border-border pl-4">
          {tools.map((tool) => (
            <ToolRenderer
              key={tool.key}
              toolName={tool.toolName}
              presentation={tool.presentation}
              state={tool.state}
              onRetry={onRetry}
            />
          ))}
          {loopMessages.map((message, index) => (
            <div
              key={`${message}-${index}`}
              className="py-1 text-xs text-muted-foreground"
            >
              {message}
            </div>
          ))}
          {errorMessage && (
            <div className="py-1 text-xs text-destructive">{errorMessage}</div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
