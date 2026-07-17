import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentTurnRequest,
} from '@/types/agent'

export type AgentEventHandler = (event: AgentEvent) => void

export function runAgentTurn(
  request: AgentTurnRequest,
  onEvent: AgentEventHandler
): Promise<void> {
  const channel = new Channel<AgentEvent>()
  channel.onmessage = onEvent
  return invoke<void>('agent_run_turn', { request, onEvent: channel })
}

export function cancelAgentTurn(runId: string): Promise<void> {
  return invoke<void>('agent_cancel_turn', { runId })
}

export function resolveAgentApproval(
  decision: AgentApprovalDecision
): Promise<void> {
  return invoke<void>('agent_resolve_approval', { decision })
}

export function isStaleAgentApprovalError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return (
    message.includes('approval') &&
    (message.includes('is not pending') ||
      message.includes('is no longer active'))
  )
}
