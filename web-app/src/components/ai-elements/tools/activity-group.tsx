import { useState } from 'react'
import { CircleAlert, ChevronRight, ListChecks, Loader2 } from 'lucide-react'

import {
  Collapsible,
  CollapsibleContent,
  CollapsibleTrigger,
} from '@/components/ui/collapsible'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { toolActivityLabel } from '@/lib/tools/activity-label'
import type { TraceBlock } from '@/lib/tools/types'
import { cn } from '@/lib/utils'
import { ToolRenderer, toolIcon } from './tool-renderer'
import { Shimmer } from '@/components/ai-elements/shimmer'

type ActivityTool = Extract<TraceBlock, { kind: 'activity' }>['tools'][number]

type ToolActivityGroupProps = {
  tools: ActivityTool[]
  errorMessage?: string
  /** The enclosing agent turn is still running or awaiting approval. */
  active?: boolean
  /** The live turn is waiting for permission, even if a call has its input. */
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
  errorMessage,
  active = false,
  working = false,
  onRetry,
}: ToolActivityGroupProps) {
  const { t } = useTranslation('chat')
  // The newest running call owns the headline. Older calls may remain in an
  // input state when a loop guard ends the turn; `active` prevents that stale
  // state from looking like work is still happening after the composer opens.
  const runningTool =
    active && !working ? [...tools].reverse().find(isRunning) : undefined
  // Completion is a turn-level state, not a tool-level state. Between calls,
  // during reasoning, while an answer streams, and while approval is pending,
  // the turn is still live and must fall back to Working rather than Completed.
  const live = active
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
    : live
      ? t('activity.working')
      : errorMessage
        ? errorMessage
        : tools.length > 0
          ? t('activity.completedActions', { count: tools.length })
          : t('activity.working')

  const hasDetails = tools.length > 0 || Boolean(errorMessage)
  const StatusIcon =
    errorMessage && !live
      ? CircleAlert
      : runningTool
        ? toolIcon(runningTool.toolName, runningTool.presentation.kind)
        : live
          ? Loader2
          : ListChecks

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
            live && !runningTool && 'animate-spin',
            errorMessage && !live && 'text-destructive'
          )}
        />
        <span className="inline-flex min-w-0 items-center gap-2">
          <span className="min-w-0 truncate">
            {live ? (
              <Shimmer
                as="span"
                className="block max-w-full truncate"
                duration={2}
              >
                {summary}
              </Shimmer>
            ) : (
              summary
            )}
          </span>
          {hasDetails && (
            <ChevronRight
              aria-hidden="true"
              className="size-3.5 shrink-0 transition-transform group-data-[state=open]/activity:rotate-90"
            />
          )}
        </span>
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
          {errorMessage && (
            <div className="py-1 text-xs text-destructive">{errorMessage}</div>
          )}
        </div>
      </CollapsibleContent>
    </Collapsible>
  )
}
