import type { UIMessage } from 'ai'
import type { AgentRunSummary } from '@/types/agent'
import { TraceBlock } from './types'
import { presentTool } from './registry'

export function buildTraceBlocks(
  message: UIMessage,
  disableReasoning: boolean,
  options: { ensureActivity?: boolean } = {}
): TraceBlock[] {
  const blocks: TraceBlock[] = []
  const metadata = message.metadata as
    | { agent_run?: AgentRunSummary; activityDurationMs?: number }
    | undefined
  const agentRun = metadata?.agent_run
  const reasoning: Array<{ key: string; text: string }> = []
  const tools: Extract<TraceBlock, { kind: 'activity' }>['tools'] = []
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
      if (!disableReasoning && part.text?.trim()) {
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

  if (activityIndex >= 0) {
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
    const index = activityIndex >= 0 ? activityIndex : reasoningIndex
    blocks.splice(index, 0, {
      kind: 'reasoning',
      key: `${message.id}-reasoning`,
      streaming:
        reasoningState === 'streaming' ||
        (reasoningState !== 'done' && !answeredAfterReasoning),
      items: reasoning,
    })
  }

  return blocks
}
