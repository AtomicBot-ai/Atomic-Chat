import type { MCPServerStatus } from '@/services/mcp/types'
import type { MCPTool } from '@/types/completion'

/**
 * The bundled Exa transport may be down while Atomic Chat's built-in keyless
 * search adapter is serving the same `web_search_exa` tool. Product UI reports
 * the usable capability, not the failed transport hidden behind its fallback.
 */
export function effectiveMcpStatus(
  serverKey: string,
  status: MCPServerStatus | undefined,
  tools: MCPTool[]
): MCPServerStatus | undefined {
  if (
    serverKey.toLowerCase() === 'exa' &&
    status?.status === 'error' &&
    tools.some(
      (tool) => tool.server === serverKey && tool.name === 'web_search_exa'
    )
  ) {
    return { name: status.name, status: 'connected' }
  }
  return status
}
