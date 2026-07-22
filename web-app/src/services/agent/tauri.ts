import { Channel, invoke } from '@tauri-apps/api/core'
import type {
  AgentApprovalDecision,
  AgentEvent,
  AgentTurnRequest,
  AgentWorkspaceEntry,
  AgentWorkspaceFile,
  AgentWorkspaceRequest,
  AgentWorkspaceText,
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

export function listAgentWorkspace(
  request: AgentWorkspaceRequest
): Promise<AgentWorkspaceEntry[]> {
  return invoke<AgentWorkspaceEntry[]>('agent_workspace_list', { request })
}

export function statAgentWorkspaceFile(
  request: AgentWorkspaceRequest
): Promise<AgentWorkspaceFile> {
  return invoke<AgentWorkspaceFile>('agent_workspace_stat', { request })
}

export function resolveAgentWorkspacePath(
  request: AgentWorkspaceRequest
): Promise<string> {
  return invoke<string>('agent_workspace_resolve_path', { request })
}

export function readAgentWorkspaceText(
  request: AgentWorkspaceRequest
): Promise<AgentWorkspaceText> {
  return invoke<AgentWorkspaceText>('agent_workspace_read_text', { request })
}

export function isStaleAgentApprovalError(error: unknown): boolean {
  const message = String(error).toLowerCase()
  return (
    message.includes('approval') &&
    (message.includes('is not pending') ||
      message.includes('is no longer active'))
  )
}
