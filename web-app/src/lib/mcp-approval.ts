import { useAgentMode } from '@/hooks/useAgentMode'
import { useToolApproval } from '@/hooks/useToolApproval'

/**
 * Whether MCP/RAG tool calls on this thread run without asking. One rule for
 * both engines (the agent's `auto_approve_mcp` and the chat pipeline's
 * approval modal):
 *
 * - The composer's approval select is authoritative once the user has picked
 *   a mode for the thread: explicit "skip" auto-approves, explicit "manual"
 *   prompts — even while the global "Allow all MCP permissions" switch is on.
 * - Until the user picks, the global switch decides. It is off by default
 *   (and reset to off once for existing users), so MCP tools ask first:
 *   they are third-party code, and their `readOnlyHint` is the server's own
 *   unverified claim. Per-tool "Always allow" still works on either engine.
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
 * The chat pipeline's approval gate for one tool call (MCP and RAG tools
 * alike). Runs silently only when {@link resolveMcpAutoApprove} says the user
 * opted in; otherwise it asks, honouring the thread's per-tool "Always
 * allow". The composer's explicit "manual" outranks the global switch, so the
 * modal is told to ignore that switch here: this function already applied it.
 */
export function approveChatToolCall(
  toolName: string,
  threadId: string,
  toolParameters?: object
): Promise<boolean> {
  if (resolveMcpAutoApprove(threadId)) return Promise.resolve(true)
  return useToolApproval
    .getState()
    .showApprovalModal(toolName, threadId, toolParameters, {
      bypassGlobalAutoApprove: true,
    })
}
