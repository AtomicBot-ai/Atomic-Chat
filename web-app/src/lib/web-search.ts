import type { MCPServerConfig, MCPServers } from '@/hooks/useMCPServers'

export type WebSearchServer = {
  key: string
  config: MCPServerConfig
}

// MCP servers whose whole job is searching the web. Exa is the hosted backend
// the app ships with; the rest are the usual drop-in replacements. The order
// here is the preference order when several of them are configured.
const KNOWN_WEB_SEARCH_KEYS = [
  'exa',
  'serper',
  'tavily',
  'brave-search',
  'brave_search',
  'web-search',
  'websearch',
]

const normalizeKey = (key: string) => key.trim().toLowerCase()

const knownKeyRank = (key: string) => {
  const rank = KNOWN_WEB_SEARCH_KEYS.indexOf(normalizeKey(key))
  return rank === -1 ? KNOWN_WEB_SEARCH_KEYS.length : rank
}

const isWebSearchServer = (key: string, config: MCPServerConfig) =>
  KNOWN_WEB_SEARCH_KEYS.includes(normalizeKey(key)) ||
  (config.url ?? '').includes('exa.ai')

/**
 * Pick the server the globe button in the composer drives. An already active
 * server wins so the button never reports "off" while web search is running;
 * otherwise the best known candidate is offered for activation.
 */
export function findWebSearchServer(
  servers: MCPServers
): WebSearchServer | undefined {
  const candidates = Object.entries(servers).filter(([key, config]) =>
    isWebSearchServer(key, config)
  )
  if (candidates.length === 0) return undefined

  const [key, config] =
    candidates.find(([, config]) => config.active) ??
    [...candidates].sort(([a], [b]) => knownKeyRank(a) - knownKeyRank(b))[0]

  return { key, config }
}
