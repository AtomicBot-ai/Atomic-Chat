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
  /**
   * Not listed in the Connectors grid or the plugins dropdown. The entry
   * stays in the catalog so `findInstalledServer` still recognizes a server
   * the user added by hand (by key or `matchUrls`) and brands its card.
   */
  hidden?: boolean
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

/** Servers the chat Browse button owns; never listed as connectors. */
export const BROWSER_SERVER_KEYS = ['Jan Browser MCP', 'browsermcp']

/**
 * System defaults from the Rust template. They are not connectors: they run
 * for agent mode, which takes its MCP catalog from the Rust engine, and stay
 * out of chat mode entirely — the chat transport never sends their tools and
 * the plugins menu never lists them, so a chat pays nothing for them.
 */
export const SYSTEM_SERVER_KEYS = ['sequential-thinking', 'filesystem', 'fetch']

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
    serverKey: 'atomicmail',
    name: 'Atomic Mail',
    author: 'Atomic Mail',
    descriptionKey: 'mcp-connectors:descriptions.atomicmail',
    // The mark ships on its own dark tile, so the bg matches it.
    icon: { bg: '#0b1017', src: '/images/connectors/atomicmail.png' },
    featured: true,
    docsUrl: 'https://github.com/Atomic-Mail/atomic-mail-agentic',
    // Keyless: the server registers its own @atomicmail.ai inbox on first use
    // (proof-of-work signup via the `register` tool), credentials stay local.
    config: {
      command: 'npx',
      args: ['-y', '@atomicmail/mcp-github'],
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
    // Notion's mark is black on a white page, so the tile is white too
    // (the same treatment as Serper) instead of an inverted black tile.
    icon: { bg: '#ffffff', src: '/images/connectors/notion.svg' },
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
  // Remote OAuth connectors below were probed for MCP OAuth discovery +
  // Dynamic Client Registration before landing here. Probed and left out:
  // Figma (registration endpoint answers 403), Stack Overflow (no
  // authorization-server metadata at all) — both would only ever fail.
  {
    serverKey: 'stripe',
    name: 'Stripe',
    author: 'Stripe',
    descriptionKey: 'mcp-connectors:descriptions.stripe',
    icon: { bg: '#635BFF', src: '/images/connectors/stripe.svg' },
    docsUrl: 'https://docs.stripe.com/mcp',
    matchUrls: ['mcp.stripe.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.stripe.com',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'supabase',
    name: 'Supabase',
    author: 'Supabase',
    descriptionKey: 'mcp-connectors:descriptions.supabase',
    icon: { bg: '#3ECF8E', src: '/images/connectors/supabase.svg' },
    docsUrl: 'https://supabase.com/docs/guides/getting-started/mcp',
    matchUrls: ['mcp.supabase.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.supabase.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'cloudflare',
    name: 'Cloudflare',
    author: 'Cloudflare',
    descriptionKey: 'mcp-connectors:descriptions.cloudflare',
    // Full-colour mark (two oranges) lifted from cloudflare.com/icons.svg, so
    // the tile is white like Notion's instead of a brand-colour fill.
    icon: { bg: '#ffffff', src: '/images/connectors/cloudflare.svg' },
    docsUrl:
      'https://developers.cloudflare.com/agents/model-context-protocol/mcp-servers-for-cloudflare/',
    matchUrls: ['mcp.cloudflare.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.cloudflare.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'posthog',
    name: 'PostHog',
    author: 'PostHog',
    descriptionKey: 'mcp-connectors:descriptions.posthog',
    icon: { bg: '#1D4AFF', src: '/images/connectors/posthog.svg' },
    docsUrl: 'https://posthog.com/docs/model-context-protocol',
    matchUrls: ['mcp.posthog.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.posthog.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'paypal',
    name: 'PayPal',
    author: 'PayPal',
    descriptionKey: 'mcp-connectors:descriptions.paypal',
    // PayPal's post-2024 navy, sampled from their own monogram asset
    // (paypalobjects.com/marketing/web/icons/monogram); #003087 was the old one.
    icon: { bg: '#002991', src: '/images/connectors/paypal.svg' },
    docsUrl: 'https://developer.paypal.com/tools/mcp-server/',
    matchUrls: ['mcp.paypal.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.paypal.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'trello',
    name: 'Trello',
    author: 'Atlassian',
    descriptionKey: 'mcp-connectors:descriptions.trello',
    icon: { bg: '#0052CC', src: '/images/connectors/trello.svg' },
    docsUrl: 'https://support.atlassian.com/trello/docs/trello-mcp-server/',
    matchUrls: ['mcp.trello.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.trello.com/v1',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'granola',
    name: 'Granola',
    author: 'Granola',
    descriptionKey: 'mcp-connectors:descriptions.granola',
    // The mark ships on its own olive tile, so the bg matches it.
    icon: { bg: '#b2c248', src: '/images/connectors/granola.png' },
    docsUrl: 'https://www.granola.ai/docs/mcp',
    matchUrls: ['mcp.granola.ai'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.granola.ai/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'calcom',
    name: 'Cal.com',
    author: 'Cal.com',
    descriptionKey: 'mcp-connectors:descriptions.calcom',
    icon: { bg: '#292929', src: '/images/connectors/calcom.svg' },
    docsUrl: 'https://cal.com/docs/developing/guides/mcp',
    matchUrls: ['mcp.cal.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.cal.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'airtable',
    name: 'Airtable',
    author: 'Airtable',
    descriptionKey: 'mcp-connectors:descriptions.airtable',
    // Full-colour mark taken from Airtable's own inline logo on airtable.com;
    // the three brand colours need a white tile, not a blue one.
    icon: { bg: '#ffffff', src: '/images/connectors/airtable.svg' },
    docsUrl: 'https://airtable.com/developers/mcp',
    matchUrls: ['mcp.airtable.com'],
    auth: 'oauth',
    config: {
      type: 'http',
      url: 'https://mcp.airtable.com/mcp',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'webflow',
    name: 'Webflow',
    author: 'Webflow',
    descriptionKey: 'mcp-connectors:descriptions.webflow',
    icon: { bg: '#146EF5', src: '/images/connectors/webflow.svg' },
    docsUrl: 'https://developers.webflow.com/data/docs/ai-tools',
    matchUrls: ['mcp.webflow.com'],
    auth: 'oauth',
    // Webflow only documents the SSE endpoint for its remote server.
    config: {
      type: 'sse',
      url: 'https://mcp.webflow.com/sse',
      command: '',
      args: [],
      env: {},
    },
  },
  {
    serverKey: 'firecrawl',
    name: 'Firecrawl',
    author: 'Firecrawl',
    descriptionKey: 'mcp-connectors:descriptions.firecrawl',
    icon: { bg: '#FF6B1A', src: '/images/connectors/firecrawl.svg' },
    docsUrl: 'https://docs.firecrawl.dev/mcp-server',
    matchUrls: ['mcp.firecrawl.dev'],
    config: {
      type: 'http',
      url: 'https://mcp.firecrawl.dev/v2/mcp',
      command: '',
      args: [],
      env: {},
    },
    secret: {
      kind: 'header',
      key: 'Authorization',
      labelKey: 'mcp-connectors:secrets.firecrawlApiKey',
      placeholder: 'fc-...',
      helpUrl: 'https://www.firecrawl.dev/app/api-keys',
      format: (value) => `Bearer ${value}`,
    },
  },
  {
    serverKey: 'perplexity',
    name: 'Perplexity',
    author: 'Perplexity',
    descriptionKey: 'mcp-connectors:descriptions.perplexity',
    icon: { bg: '#20808D', src: '/images/connectors/perplexity.svg' },
    docsUrl: 'https://docs.perplexity.ai/guides/mcp-server',
    matchUrls: ['api.perplexity.ai/mcp'],
    config: {
      type: 'http',
      url: 'https://api.perplexity.ai/mcp',
      command: '',
      args: [],
      env: {},
    },
    secret: {
      kind: 'header',
      key: 'Authorization',
      labelKey: 'mcp-connectors:secrets.perplexityApiKey',
      placeholder: 'pplx-...',
      helpUrl: 'https://www.perplexity.ai/settings/api',
      format: (value) => `Bearer ${value}`,
    },
  },
  {
    serverKey: 'zapier',
    name: 'Zapier',
    author: 'Zapier',
    descriptionKey: 'mcp-connectors:descriptions.zapier',
    icon: { bg: '#FF4A00', src: '/images/connectors/zapier.svg' },
    docsUrl: 'https://docs.zapier.com/mcp',
    matchUrls: ['mcp.zapier.com'],
    config: {
      type: 'http',
      url: 'https://mcp.zapier.com/api/mcp/mcp',
      command: '',
      args: [],
      env: {},
    },
    secret: {
      kind: 'header',
      key: 'Authorization',
      labelKey: 'mcp-connectors:secrets.zapierToken',
      placeholder: '...',
      helpUrl: 'https://mcp.zapier.com',
      format: (value) => `Bearer ${value}`,
    },
  },
  {
    serverKey: 'resend',
    name: 'Resend',
    author: 'Resend',
    descriptionKey: 'mcp-connectors:descriptions.resend',
    icon: { bg: '#000000', src: '/images/connectors/resend.svg' },
    docsUrl: 'https://resend.com/docs/knowledge-base/mcp-server',
    config: {
      command: 'npx',
      args: ['-y', 'resend-mcp'],
      env: {},
    },
    secret: {
      kind: 'env',
      key: 'RESEND_API_KEY',
      labelKey: 'mcp-connectors:secrets.resendApiKey',
      placeholder: 're_...',
      helpUrl: 'https://resend.com/api-keys',
    },
  },
  {
    serverKey: 'shopify-dev',
    name: 'Shopify Dev',
    author: 'Shopify',
    descriptionKey: 'mcp-connectors:descriptions.shopify-dev',
    icon: { bg: '#96BF48', src: '/images/connectors/shopify-dev.svg' },
    docsUrl: 'https://shopify.dev/docs/apps/build/devmcp',
    config: {
      command: 'npx',
      args: ['-y', '@shopify/dev-mcp@latest'],
      env: {},
    },
  },
  // Hidden while its sign-in is 'oauth-soon': GitHub's remote MCP has no
  // Dynamic Client Registration (OAuth is limited to registered apps like the
  // first-party Copilot IDEs), so browser sign-in cannot work yet. The entry
  // stays so a hand-added server (e.g. with a PAT header) still gets the card.
  {
    serverKey: 'github',
    hidden: true,
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
