import type { MCPServerConfig, MCPServers } from '@/hooks/useMCPServers'

/**
 * Hand-picked MCP connector catalog for the Connectors page.
 *
 * Config templates intentionally duplicate the Rust default template in
 * src-tauri/src/core/mcp/constants.rs (DEFAULT_MCP_CONFIG_TEMPLATE): the Rust
 * side seeds fresh installs, this catalog lets existing users (re-)add a
 * connector in one click. Keep the two in sync when bumping a pinned version.
 */

export type ConnectorSecret = {
  kind: 'env' | 'header'
  /** Env var name (SERPER_API_KEY) or header name (Authorization). */
  key: string
  /** i18n key under mcp-connectors for the input label. */
  labelKey: string
  placeholder: string
  /** "Get your API key" link. */
  helpUrl?: string
  /** Wrap the raw value, e.g. (v) => `Bearer ${v}` for token headers. */
  format?: (value: string) => string
}

export type MCPConnector = {
  /** Server key written to mcp_config.json — matches the Rust template keys. */
  serverKey: string
  /** Product name (not localized, matching integrations.ts convention). */
  name: string
  /** "By X" attribution (not localized). */
  author: string
  /** i18n key: mcp-connectors:descriptions.<id>. */
  descriptionKey: string
  /** Brand tile background; no image asset means a monogram is rendered. */
  icon: { bg: string; src?: string }
  /** Featured connector: badge + sorts first. */
  featured?: boolean
  docsUrl?: string
  /** Static config template; `active` and secrets are injected on install. */
  config: MCPServerConfig
  /** Override for connectors whose config needs runtime values. */
  resolveConfig?: () => Promise<MCPServerConfig>
  secret?: ConnectorSecret
  /** URL substrings identifying this connector when the key differs. */
  matchUrls?: string[]
}

/** Matches useJanBrowserExtension: driven by the chat Browse button, never listed. */
export const HIDDEN_SERVER_KEYS = ['Jan Browser MCP']

// Pinned to match FILESYSTEM_MCP_PINNED_VERSION in src-tauri constants.rs.
const FILESYSTEM_MCP_SPEC = '@modelcontextprotocol/server-filesystem@2026.1.14'

export const MCP_CONNECTORS: MCPConnector[] = [
  {
    serverKey: 'exa',
    name: 'Exa',
    author: 'Exa',
    descriptionKey: 'mcp-connectors:descriptions.exa',
    icon: { bg: '#1741f6' },
    featured: true,
    docsUrl: 'https://docs.exa.ai',
    matchUrls: ['exa.ai'],
    config: {
      type: 'http',
      url: 'https://mcp.exa.ai/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'fetch',
    name: 'Fetch',
    author: 'Anthropic',
    descriptionKey: 'mcp-connectors:descriptions.fetch',
    icon: { bg: '#0f766e' },
    docsUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/fetch',
    config: {
      command: 'uvx',
      args: ['mcp-server-fetch'],
      env: {},
    },
  },
  {
    serverKey: 'filesystem',
    name: 'Filesystem',
    author: 'Anthropic',
    descriptionKey: 'mcp-connectors:descriptions.filesystem',
    icon: { bg: '#b45309' },
    docsUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/filesystem',
    config: {
      command: 'npx',
      args: ['-y', FILESYSTEM_MCP_SPEC],
      env: {},
    },
    // The sandbox dir mirrors default_filesystem_root() on the Rust side
    // (~/Documents/Atomic_chat); resolved at install time, not module load.
    resolveConfig: async () => {
      const { documentDir, join } = await import('@tauri-apps/api/path')
      const root = await join(await documentDir(), 'Atomic_chat')
      return {
        command: 'npx',
        args: ['-y', FILESYSTEM_MCP_SPEC, root],
        env: {},
        cwd: root,
      }
    },
  },
  {
    serverKey: 'sequential-thinking',
    name: 'Sequential Thinking',
    author: 'Anthropic',
    descriptionKey: 'mcp-connectors:descriptions.sequentialThinking',
    icon: { bg: '#6d28d9' },
    docsUrl:
      'https://github.com/modelcontextprotocol/servers/tree/main/src/sequentialthinking',
    config: {
      command: 'npx',
      args: ['-y', '@modelcontextprotocol/server-sequential-thinking'],
      env: {},
    },
  },
  {
    serverKey: 'browsermcp',
    name: 'Browser MCP',
    author: 'Browser MCP',
    descriptionKey: 'mcp-connectors:descriptions.browsermcp',
    icon: { bg: '#dc2626' },
    docsUrl: 'https://browsermcp.io',
    config: {
      command: 'npx',
      args: ['@browsermcp/mcp'],
      env: {},
    },
  },
  {
    serverKey: 'serper',
    name: 'Serper',
    author: 'Serper',
    descriptionKey: 'mcp-connectors:descriptions.serper',
    icon: { bg: '#171717' },
    docsUrl: 'https://serper.dev',
    config: {
      command: 'npx',
      args: ['-y', 'serper-search-scrape-mcp-server'],
      env: {},
    },
    secret: {
      kind: 'env',
      key: 'SERPER_API_KEY',
      labelKey: 'mcp-connectors:secrets.serperApiKey',
      placeholder: 'sk-...',
      helpUrl: 'https://serper.dev/api-key',
    },
  },
]

const normalizeKey = (key: string) => key.trim().toLowerCase()

/**
 * Finds the user's server entry matching a catalog connector, by key
 * (case-insensitive) or by URL substring (the exa-by-url precedent from
 * lib/web-search.ts).
 */
export function findInstalledServer(
  connector: MCPConnector,
  servers: MCPServers
): { key: string; config: MCPServerConfig } | undefined {
  for (const [key, config] of Object.entries(servers)) {
    if (normalizeKey(key) === normalizeKey(connector.serverKey)) {
      return { key, config }
    }
    if (connector.matchUrls?.some((url) => (config.url ?? '').includes(url))) {
      return { key, config }
    }
  }
  return undefined
}

/**
 * Builds the config to install: resolves runtime values and injects the
 * user-provided secret into env or headers. Never mutates the template.
 */
export async function buildConnectorConfig(
  connector: MCPConnector,
  secretValue?: string
): Promise<MCPServerConfig> {
  const base = connector.resolveConfig
    ? await connector.resolveConfig()
    : structuredClone(connector.config)

  const secret = connector.secret
  const value = secretValue?.trim()
  if (secret && value) {
    const formatted = secret.format ? secret.format(value) : value
    if (secret.kind === 'env') {
      base.env = { ...base.env, [secret.key]: formatted }
    } else {
      base.headers = { ...base.headers, [secret.key]: formatted }
    }
  }
  return base
}
