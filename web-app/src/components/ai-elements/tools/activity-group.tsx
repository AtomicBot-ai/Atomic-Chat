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
  // The newest concrete step owns the live headline, including the interval
  // after its result/error arrives and before the next call starts. Tool parts
  // can advance to an output state while the enclosing turn is still active;
  // falling back to Working at that point hides the step already visible in
  // the timeline. Taking the newest part also avoids an older, stale input
  // state winning over a later completed call during streamed updates.
  const headlineTool = active && !working ? tools.at(-1) : undefined
  // Completion is a turn-level state, not a tool-level state. While the turn
  // is live, Working is reserved for the period before the first concrete
  // call and explicit permission/folder-access waits.
  const live = active
  // A live turn stays one stable row. The user can opt into the detailed
  // timeline, but new tool calls never expand it and shove the answer around.
  const [open, setOpen] = useState(false)

  const summary = headlineTool
    ? toolActivityLabel(
        headlineTool.toolName,
        headlineTool.presentation,
        headlineTool.state,
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
      : headlineTool
        ? toolIcon(headlineTool.toolName, headlineTool.presentation.kind)
        : live
          ? Loader2
          : ListChecks
  const headlineDenied =
    (headlineTool?.state as string | undefined) === 'output-denied'
  const headlineSkipped =
    headlineDenied &&
    headlineTool?.presentation.kind === 'generic' &&
    headlineTool.presentation.deniedReason === 'tool-loop'
  const headlineFailed =
    headlineTool?.state === 'output-error' ||
    (headlineDenied && !headlineSkipped)

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
            live && !headlineTool && 'animate-spin',
            (headlineFailed || (errorMessage && !live)) && 'text-destructive'
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
