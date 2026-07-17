export type MessageExecutionRoute = 'agent-ipc' | 'chat-transport'

export function resolveMessageExecutionRoute(
  agentMode: boolean
): MessageExecutionRoute {
  return agentMode ? 'agent-ipc' : 'chat-transport'
}
