import { useMCPServers } from '@/hooks/useMCPServers'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  ensureSecureEnvironmentsLoaded,
  secureEnvironmentForThread,
} from '@/hooks/useSecureEnvironments'
import { getServiceHub } from '@/hooks/useServiceHub'
import { isWebSearchServer } from '@/lib/web-search'
import { agentProviderBlockReason } from '@/lib/agent-provider'
import { agentModelBlockReason } from '@/lib/managed-engine/chat'
import type { MCPTool } from '@/types/completion'

export function piModelAvailable(
  provider: ModelProvider | undefined,
  model: Model | undefined
) {
  return Boolean(
    provider &&
      model?.capabilities?.includes('tools') &&
      (provider.provider === 'strata' || !agentProviderBlockReason(provider)) &&
      !agentModelBlockReason(provider.provider, model)
  )
}

export function connectorEnabled(id: string, server: string, name: string) {
  const config = useMCPServers.getState().mcpServers[server]
  const access = useToolAvailable.getState()
  const secure = secureEnvironmentForThread(id)
  return (
    (!config || Boolean(config.active)) &&
    !access.isServerMutedForThread(id, server) &&
    !access.isToolDisabled(id, server, name) &&
    (!secure ||
      (secure.allowedMcpServers.includes(server) &&
        (secure.network || !config || !isWebSearchServer(server, config))))
  )
}

export async function piConnectors(id: string): Promise<MCPTool[]> {
  await ensureSecureEnvironmentsLoaded()
  const tools = await getServiceHub().mcp().getTools()
  return (tools ?? [])
    .filter((tool) => connectorEnabled(id, tool.server, tool.name))
    .map(({ server, name, description, inputSchema }) => ({
      server,
      name,
      description: description ?? '',
      inputSchema,
    }))
}

export function piSkillPrompt(text: string, selected?: string) {
  if (!selected) return text
  const words = text.split(/(\s+)/)
  const index = words.indexOf('/' + selected)
  if (index >= 0)
    words.splice(index, /^\s+$/.test(words[index + 1] ?? '') ? 2 : 1)
  return ('/skill:' + selected + ' ' + words.join('').trim()).trimEnd()
}
