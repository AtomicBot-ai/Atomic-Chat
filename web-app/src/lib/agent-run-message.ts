import type { UIMessage } from 'ai'
import type {
  AgentRunState,
  AgentRunSummary,
  AgentToolStatus,
} from '@/types/agent'

const LOOP_MESSAGE_LIMIT = 500
const ERROR_MESSAGE_LIMIT = 1_000

function bounded(value: string, limit: number): string {
  return value.length > limit ? `${value.slice(0, limit)}…` : value
}

function toolPartState(status?: AgentToolStatus): string {
  if (!status) return 'input-available'
  if (status === 'ok') return 'output-available'
  if (status === 'denied') return 'output-denied'
  return 'output-error'
}

export function claimAgentRunPersistence(
  persistedRunIds: Set<string>,
  runId: string | undefined
): boolean {
  if (!runId || persistedRunIds.has(runId)) return false
  persistedRunIds.add(runId)
  return true
}

export function buildAgentRunSummary(state: AgentRunState): AgentRunSummary {
  const durationMs =
    state.startedAtMs !== undefined && state.finishedAtMs !== undefined
      ? Math.max(0, state.finishedAtMs - state.startedAtMs)
      : undefined

  return {
    run_id: state.runId ?? '',
    status: state.status,
    finish_reason: state.trace.finishReason,
    step_count: state.trace.stepCount,
    duration_ms: durationMs,
    tools: state.trace.tools.map((tool) => ({
      tool: tool.call.tool,
      status: tool.outcome?.status,
      batch_index: tool.batchIndex,
      batch_size: tool.batchSize,
    })),
    loops: state.trace.loops.map((loop) => ({
      ...loop,
      message: bounded(loop.message, LOOP_MESSAGE_LIMIT),
    })),
    error: state.trace.error
      ? {
          ...state.trace.error,
          message: bounded(state.trace.error.message, ERROR_MESSAGE_LIMIT),
        }
      : undefined,
  }
}

export function buildAgentUIMessage(state: AgentRunState): UIMessage {
  const runId = state.runId ?? 'pending'
  const parts: Array<Record<string, unknown>> = []
  const reasoning = Object.entries(state.trace.reasoning)
    .sort(([left], [right]) => Number(left) - Number(right))
    .map(([, text]) => text)
    .join('')

  if (reasoning) {
    parts.push({ type: 'reasoning', text: reasoning })
  }
  for (const [index, tool] of state.trace.tools.entries()) {
    if (tool.call.tool === 'reply' || tool.call.tool === 'finish') continue
    parts.push({
      type: `tool-${tool.call.tool}`,
      toolCallId: `agent-${runId}-${index}`,
      state: toolPartState(tool.outcome?.status),
      input: tool.call.args,
      output: tool.outcome,
      errorText:
        tool.outcome && tool.outcome.status !== 'ok'
          ? tool.outcome.summary
          : undefined,
    })
  }
  if (state.trace.assistantText) {
    parts.push({ type: 'text', text: state.trace.assistantText })
  }

  return {
    id: `agent-${runId}`,
    role: 'assistant',
    parts: parts as UIMessage['parts'],
    metadata: {
      agent_run: buildAgentRunSummary(state),
    },
  }
}
