import { useAgentMode } from '@/hooks/useAgentMode'
import { useToolApproval } from '@/hooks/useToolApproval'
import { offeredChatExecToolNames } from '@/lib/chat-exec-tools'

/**
 * Whether MCP/RAG tool calls on this thread run without asking. One rule for
 * both engines (the agent's `auto_approve_mcp` and the chat pipeline's
 * approval modal):
 *
 * - The composer's approval select is authoritative once the user has picked
 *   a mode for the thread: explicit "skip" auto-approves, explicit "manual"
 *   prompts — even while the global "Allow all MCP permissions" switch is on.
 * - Until the user picks, the global switch keeps its historical meaning
 *   (default on), so untouched threads stay prompt-free.
 *
 * The agent's dangerous built-in tools (shell etc.) are NOT governed by this:
 * they gate on the approval mode alone, defaulting to manual.
 */
export function resolveMcpAutoApprove(threadId: string): boolean {
  const explicit = useAgentMode.getState().approvalModes[threadId]
  if (explicit) return explicit === 'skip'
  return useToolApproval.getState().allowAllMCPPermissions
}

/**
 * Whether chat's own `run_command` / `run_script` calls run without asking:
 * only on an explicit "skip" (Full access). Like the agent's shell they gate
 * on the approval mode alone — the global "Allow all MCP permissions" switch
 * never covers them.
 */
export function resolveExecAutoApprove(threadId: string): boolean {
  return useAgentMode.getState().approvalModes[threadId] === 'skip'
}

/** The chat pipeline's approval step for one tool call. */
export function approveChatToolCall(
  toolName: string,
  threadId: string,
  input: object
): Promise<boolean> {
  const autoApprove = offeredChatExecToolNames().has(toolName)
    ? resolveExecAutoApprove(threadId)
    : resolveMcpAutoApprove(threadId)
  return autoApprove
    ? Promise.resolve(true)
    : useToolApproval.getState().showApprovalModal(toolName, threadId, input, {
        bypassGlobalAutoApprove: true,
      })
}
