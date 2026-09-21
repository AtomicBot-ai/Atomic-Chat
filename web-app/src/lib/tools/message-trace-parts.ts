import type { UIMessage } from 'ai'
import type { AgentRunSummary } from '@/types/agent'
import { TraceBlock } from './types'
import { presentTool } from './registry'

type ActivityTraceBlock = Extract<TraceBlock, { kind: 'activity' }>

/** Permission waits belong to the same turn as running tools and reasoning. */
export function isAgentTurnActive(status: AgentRunSummary['status']): boolean {
  return (
    status === 'running' ||
    status === 'awaiting_approval' ||
    status === 'awaiting_folder_access'
  )
}

/**
 * Whether an activity block has anything behind its header: tool calls (the
 * terminal `reply` / `finish` are the answer itself, not a step), agent loops,
 * or a run's error. Without any of those the header is all there is.
 */
export function activityHasDetails(
  block: Pick<ActivityTraceBlock, 'tools' | 'agentSummary'>
): boolean {
  const summary = block.agentSummary
  const summaryToolCount =
    summary?.tools.filter(({ tool }) => tool !== 'reply' && tool !== 'finish')
      .length ?? 0
  return (
    block.tools.length > 0 ||
    summaryToolCount > 0 ||
    (summary?.loops.length ?? 0) > 0 ||
    Boolean(summary?.error)
  )
}

/**
 * Projects a message's parts into render blocks. A message renders the parts
 * it actually has: whether reasoning was requested is decided per request
 * (see `custom-chat-transport.ts` and `buildAgentReasoningRequest`), never
 * here, so the transcript on screen does not move when the effort setting
 * changes.
 */
export function buildTraceBlocks(
  message: UIMessage,
  options: { ensureActivity?: boolean } = {}
): TraceBlock[] {
  const blocks: TraceBlock[] = []
  const metadata = message.metadata as
    | { agent_run?: AgentRunSummary; activityDurationMs?: number }
    | undefined
  const agentRun = metadata?.agent_run
  const reasoning: Array<{ key: string; text: string }> = []
  const tools: ActivityTraceBlock['tools'] = []
  let reasoningIndex = -1
  let reasoningState: 'streaming' | 'done' | undefined
  let answeredAfterReasoning = false
  let activityIndex =
    agentRun ||
    metadata?.activityDurationMs !== undefined ||
    options.ensureActivity
      ? 0
      : -1

  for (let i = 0; i < message.parts.length; i++) {
    const part = message.parts[i]

    if (part.type === 'text') {
      if (part.text?.trim()) {
        if (reasoning.length > 0) answeredAfterReasoning = true
        blocks.push({
          kind: 'text',
          key: `${message.id}-${i}`,
          text: part.text,
        })
      }
      continue
    }

    if (part.type === 'reasoning') {
      if (part.text?.trim()) {
        if (reasoningIndex < 0) reasoningIndex = blocks.length
        reasoningState = part.state
        answeredAfterReasoning = false
        reasoning.push({
          key: `${message.id}-${i}`,
          text: part.text,
        })
      }
      continue
    }

    if (part.type === 'file') {
      const filePart = part as {
        type: 'file'
        url?: string
        mediaType?: string
        filename?: string
      }
      if (filePart.url && filePart.mediaType?.startsWith('image/')) {
        blocks.push({
          kind: 'file',
          key: `${message.id}-${i}`,
          url: filePart.url,
          mediaType: filePart.mediaType,
          filename: filePart.filename,
        })
      } else if (filePart.url && filePart.mediaType?.startsWith('audio/')) {
        blocks.push({
          kind: 'audio',
          key: `${message.id}-${i}`,
          url: filePart.url,
          mediaType: filePart.mediaType,
          filename: filePart.filename,
        })
      }
      continue
    }

    if (typeof part.type === 'string' && part.type.startsWith('tool-')) {
      const toolName = part.type.slice('tool-'.length)
      if (toolName === 'reply' || toolName === 'finish') continue
      if (activityIndex < 0) activityIndex = blocks.length
      const state = 'state' in part ? part.state : 'output-available'
      const input = 'input' in part ? part.input : undefined
      const output = 'output' in part ? part.output : undefined
      const errorText =
        'errorText' in part
          ? part.errorText
          : 'error' in part
            ? String(part.error)
            : undefined

      tools.push({
        key: `${message.id}-${i}`,
        toolName,
        state,
        presentation: presentTool({
          toolName,
          input,
          output,
          errorText,
          state,
        }),
      })
    }
  }

  const reasoningStreaming =
    reasoning.length > 0 &&
    (reasoningState === 'streaming' ||
      (reasoningState !== 'done' && !answeredAfterReasoning))

  // Whether the block is still reporting live work: the turn this message
  // belongs to is in flight, or its agent run has not reached an end state.
  const isLive =
    options.ensureActivity ??
    (agentRun !== undefined && isAgentTurnActive(agentRun.status))

  // What the block is allowed to be:
  //
  //  - Something to expand — tool calls, agent loops, a run's error. Shown
  //    whenever it exists; that list is the only place those are traced.
  //  - A live "Working" row before the first call and between calls. It remains
  //    mounted through reasoning and answer streaming so activity never looks
  //    complete, disappears, and then restarts while the enclosing turn lives.
  //  - Never a bare "Worked for 2.9s" once the turn is over (ATO-534). With
  //    nothing to expand it only restated the "Thought for" header right above
  //    it. The duration stays in the message metadata for telemetry.
  const hasDetails = activityHasDetails({ tools, agentSummary: agentRun })
  const showActivity = activityIndex >= 0 && (hasDetails || isLive)

  if (showActivity) {
    blocks.splice(activityIndex, 0, {
      kind: 'activity',
      key: `${message.id}-activity`,
      durationMs: agentRun?.duration_ms ?? metadata?.activityDurationMs,
      tools,
      agentSummary: agentRun,
    })
  }

  if (reasoning.length > 0) {
    // Reasoning sits above the activity block so the thinking stream reads as
    // its own step rather than a detail nested inside "Working".
    const index = showActivity ? activityIndex : reasoningIndex
    blocks.splice(index, 0, {
      kind: 'reasoning',
      key: `${message.id}-reasoning`,
      streaming: reasoningStreaming,
      items: reasoning,
    })
  }

  return blocks
}
