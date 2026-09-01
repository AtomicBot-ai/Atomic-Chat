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
  /**
   * `'oauth'`: signs in via the browser (MCP OAuth 2.1 — discovery, dynamic
   * client registration, PKCE — run by the Rust side). `'oauth-soon'`: the
   * provider requires OAuth but does not accept dynamic registration yet
   * (GitHub), so the card shows a disabled "Sign in"; the config template is
   * real so a hand-added server (e.g. with a PAT header) is still recognized.
   */
  auth?: 'oauth' | 'oauth-soon'
}

/**
 * Servers the UI never lists: 'Jan Browser MCP' is driven by the chat Browse
 * button (matches useJanBrowserExtension), the rest are system defaults seeded
 * by the Rust template (DEFAULT_MCP_CONFIG_TEMPLATE) and not user-facing
 * connectors. Keys are exact matches against mcp_config.json.
 */
export const HIDDEN_SERVER_KEYS = [
  'Jan Browser MCP',
  'browsermcp',
  'sequential-thinking',
  'filesystem',
  'fetch',
]

export const MCP_CONNECTORS: MCPConnector[] = [
  {
    serverKey: 'exa',
    name: 'Exa',
    author: 'Exa',
    descriptionKey: 'mcp-connectors:descriptions.exa',
    icon: { bg: '#1741f6', src: '/images/connectors/exa.svg' },
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
    serverKey: 'linear',
    name: 'Linear',
    author: 'Linear',
    descriptionKey: 'mcp-connectors:descriptions.linear',
    icon: { bg: '#5E6AD2', src: '/images/connectors/linear.svg' },
    docsUrl: 'https://linear.app/docs/mcp',
    matchUrls: ['mcp.linear.app'],
    auth: 'oauth',
    // Streamable HTTP at /mcp — Linear retired the /sse endpoint (404s now).
    config: {
      type: 'http',
      url: 'https://mcp.linear.app/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'notion',
    name: 'Notion',
    author: 'Notion',
    descriptionKey: 'mcp-connectors:descriptions.notion',
    icon: { bg: '#191919', src: '/images/connectors/notion.svg' },
    docsUrl: 'https://developers.notion.com/docs/mcp',
    matchUrls: ['mcp.notion.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.notion.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'sentry',
    name: 'Sentry',
    author: 'Sentry',
    descriptionKey: 'mcp-connectors:descriptions.sentry',
    icon: { bg: '#362D59', src: '/images/connectors/sentry.svg' },
    docsUrl: 'https://docs.sentry.io/product/sentry-mcp/',
    matchUrls: ['mcp.sentry.dev'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.sentry.dev/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'atlassian',
    name: 'Atlassian',
    author: 'Atlassian',
    descriptionKey: 'mcp-connectors:descriptions.atlassian',
    icon: { bg: '#0052CC', src: '/images/connectors/atlassian.svg' },
    docsUrl:
      'https://support.atlassian.com/rovo/docs/getting-started-with-the-atlassian-remote-mcp-server/',
    matchUrls: ['mcp.atlassian.com'],
    auth: 'oauth',
    // /v1/sse still answers today, but SSE is the deprecated transport —
    // streamable HTTP is the one Atlassian documents going forward.
    config: {
      type: 'http',
      url: 'https://mcp.atlassian.com/v1/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'serper',
    name: 'Serper',
    author: 'Serper',
    descriptionKey: 'mcp-connectors:descriptions.serper',
    // The mark ships on its own white tile, so the bg matches it.
    icon: { bg: '#ffffff', src: '/images/connectors/serper.png' },
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
  // Last while its sign-in is 'oauth-soon': GitHub's remote MCP has no
  // Dynamic Client Registration (OAuth is limited to registered apps like the
  // first-party Copilot IDEs), so browser sign-in cannot work yet.
  {
    serverKey: 'github',
    name: 'GitHub',
    author: 'GitHub',
    descriptionKey: 'mcp-connectors:descriptions.github',
    icon: { bg: '#181717', src: '/images/connectors/github.svg' },
    docsUrl: 'https://github.com/github/github-mcp-server',
    matchUrls: ['api.githubcopilot.com'],
    auth: 'oauth-soon',
    config: {
      type: 'http',
      url: 'https://api.githubcopilot.com/mcp/',
      command: '',
      args: [],
      env: {},
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
