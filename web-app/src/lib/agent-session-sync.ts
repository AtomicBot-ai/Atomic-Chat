import { ContentType, type ThreadMessage } from '@janhq/core'
import type { AgentReseedMessage } from '@/types/agent'

/**
 * Build the authoritative message list for `agent_session_reseed` from the
 * thread's persisted messages. User messages prefer the exact text the agent
 * engine was given (`metadata.agent_input_text`); assistant messages use their
 * joined text content. Messages with no text at all are skipped.
 */
export function buildAgentSessionSyncMessages(
  messages: readonly ThreadMessage[]
): AgentReseedMessage[] {
  const result: AgentReseedMessage[] = []
  for (const message of messages) {
    if (message.role !== 'user' && message.role !== 'assistant') continue
    const metadata = (message.metadata ?? {}) as Record<string, unknown>
    const storedText = metadata.agent_input_text
    const text =
      message.role === 'user' && typeof storedText === 'string'
        ? storedText
        : (message.content ?? [])
            .filter((content) => content.type === ContentType.Text)
            .map((content) => content.text?.value ?? '')
            .join('')
    if (!text.trim()) continue
    result.push({ role: message.role, text })
  }
  return result
}
