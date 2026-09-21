import { existsSync } from 'node:fs'
import { join } from 'node:path'
import { describe, it, expect } from 'vitest'
import {
  HIDDEN_SERVER_KEYS,
  MCP_CONNECTORS,
  findInstalledServer,
  buildConnectorConfig,
} from '../mcp-connectors'
import type { MCPServers } from '@/hooks/useMCPServers'
import en from '@/locales/en/mcp-connectors.json'

const exa = MCP_CONNECTORS.find((c) => c.serverKey === 'exa')!
const resend = MCP_CONNECTORS.find((c) => c.serverKey === 'resend')!
const github = MCP_CONNECTORS.find((c) => c.serverKey === 'github')!

describe('findInstalledServer', () => {
  it('matches by exact key', () => {
    const servers: MCPServers = {
      exa: { command: '', args: [], env: {}, type: 'http', url: 'https://x' },
    }
    expect(findInstalledServer(exa, servers)?.key).toBe('exa')
  })

  it('matches by key case-insensitively', () => {
    const servers: MCPServers = {
      Exa: { command: '', args: [], env: {} },
    }
    expect(findInstalledServer(exa, servers)?.key).toBe('Exa')
  })

  it('matches by url substring when the key differs', () => {
    const servers: MCPServers = {
      'my search': {
        command: '',
        args: [],
        env: {},
        type: 'http',
        url: 'https://mcp.exa.ai/mcp?key=abc',
      },
    }
    expect(findInstalledServer(exa, servers)?.key).toBe('my search')
  })

  it('does not false-positive on unrelated servers', () => {
    const servers: MCPServers = {
      other: {
        command: 'npx',
        args: ['something'],
        env: {},
        type: 'http',
        url: 'https://example.com/mcp',
      },
    }
    expect(findInstalledServer(exa, servers)).toBeUndefined()
    expect(findInstalledServer(github, servers)).toBeUndefined()
  })
})

describe('buildConnectorConfig', () => {
  it('injects an env secret without mutating the template', async () => {
    const config = await buildConnectorConfig(resend, 'my-key')
    expect(config.env.RESEND_API_KEY).toBe('my-key')
    expect(resend.config.env.RESEND_API_KEY).toBeUndefined()
  })

  it('trims the secret and skips empty values', async () => {
    const config = await buildConnectorConfig(resend, '  ')
    expect(config.env.RESEND_API_KEY).toBeUndefined()
  })

  it('injects a header secret with formatting', async () => {
    const connector = {
      ...resend,
      secret: {
        kind: 'header' as const,
        key: 'Authorization',
        labelKey: 'x',
        placeholder: '',
        format: (v: string) => `Bearer ${v}`,
      },
    }
    const config = await buildConnectorConfig(connector, 'tok')
    expect(config.headers?.Authorization).toBe('Bearer tok')
  })

  it('returns a fresh clone for keyless connectors', async () => {
    const config = await buildConnectorConfig(exa)
    expect(config).toEqual(exa.config)
    expect(config).not.toBe(exa.config)
  })
})

describe('catalog hygiene', () => {
  it('ships no placeholder sentinels', () => {
    const raw = JSON.stringify(MCP_CONNECTORS.map((c) => c.config))
    expect(raw).not.toMatch(/YOUR_.*_HERE/)
  })

  it('remote templates always carry an explicit transport type', () => {
    for (const connector of MCP_CONNECTORS) {
      if (connector.config.url) {
        expect(connector.config.type).toMatch(/^(http|sse)$/)
      }
    }
  })

  it('oauth connectors are remote, recognizable by URL, and keyless', () => {
    const oauth = MCP_CONNECTORS.filter((c) => c.auth !== undefined)
    expect(oauth.length).toBeGreaterThan(0)
    for (const connector of oauth) {
      expect(connector.config.url).toBeTruthy()
      expect(connector.config.type).toMatch(/^(http|sse)$/)
      expect(connector.matchUrls?.length).toBeGreaterThan(0)
      expect(connector.secret).toBeUndefined()
    }
  })

  it('never lists a hidden server key in the catalog', () => {
    for (const connector of MCP_CONNECTORS) {
      expect(HIDDEN_SERVER_KEYS).not.toContain(connector.serverKey)
    }
  })

  it('uses a unique server key per connector', () => {
    const keys = MCP_CONNECTORS.map((c) => c.serverKey.toLowerCase())
    expect(new Set(keys).size).toBe(keys.length)
  })

  it('injects header secrets only into remote templates and env secrets only into local ones', () => {
    for (const connector of MCP_CONNECTORS) {
      if (!connector.secret) continue
      if (connector.secret.kind === 'header') {
        expect(connector.config.url).toBeTruthy()
        expect(connector.matchUrls?.length).toBeGreaterThan(0)
      } else {
        expect(connector.config.command).toBeTruthy()
        expect(connector.config.url).toBeUndefined()
      }
    }
  })

  it('ships every referenced icon asset', () => {
    const publicDir = join(__dirname, '..', '..', '..', 'public')
    for (const connector of MCP_CONNECTORS) {
      if (!connector.icon.src) continue
      expect(connector.icon.src).toMatch(/^\/images\/connectors\//)
      expect(
        existsSync(join(publicDir, connector.icon.src)),
        `${connector.serverKey}: ${connector.icon.src}`
      ).toBe(true)
    }
  })

  // A fresh install seeds Exa switched on (DEFAULT_MCP_CONFIG_TEMPLATE in
  // src-tauri/src/core/mcp/constants.rs). Serper did the same job behind an
  // API key and only ever showed up as an off row in the plugins menu, so it
  // is gone from the defaults and from here alike.
  it('offers one web search, without a keyed duplicate of it', () => {
    const keys = MCP_CONNECTORS.map((c) => c.serverKey)
    expect(keys).toContain('exa')
    expect(keys).not.toContain('serper')
  })

  it('hides only entries whose sign-in cannot work yet', () => {
    for (const connector of MCP_CONNECTORS.filter((c) => c.hidden)) {
      expect(connector.auth).toBe('oauth-soon')
    }
  })
})

describe('taglines', () => {
  const taglines = (en as { taglines?: Record<string, string> }).taglines ?? {}

  it('gives every catalog connector a short tagline that exists in the English locale', () => {
    for (const connector of MCP_CONNECTORS) {
      expect(connector.taglineKey, connector.serverKey).toBe(
        `mcp-connectors:taglines.${connector.serverKey}`
      )
      const text = taglines[connector.serverKey]
      expect(text, connector.serverKey).toMatch(/^\S(.*\S)?$/)
      expect(text, connector.serverKey).not.toMatch(/\.$/)
      // "Two or three words"; an ampersand counts as one.
      expect(text.split(/\s+/).length, connector.serverKey).toBeLessThanOrEqual(
        4
      )
    }
  })

  it('leaves no tagline for a connector that is not in the catalog', () => {
    const known = new Set(MCP_CONNECTORS.map((c) => c.serverKey))
    for (const key of Object.keys(taglines)) {
      expect(known.has(key), key).toBe(true)
    }
  })
})

describe('locale hygiene', () => {
  const locale = en as {
    descriptions?: Record<string, string>
    secrets?: Record<string, string>
  }

  it('leaves no description or secret label behind for a connector that is not in the catalog', () => {
    const known = new Set(MCP_CONNECTORS.map((c) => c.serverKey))
    for (const key of Object.keys(locale.descriptions ?? {})) {
      expect(known.has(key), key).toBe(true)
    }
    const secretLabels = new Set(
      MCP_CONNECTORS.flatMap((c) =>
        c.secret
          ? [c.secret.labelKey.replace('mcp-connectors:secrets.', '')]
          : []
      )
    )
    for (const key of Object.keys(locale.secrets ?? {})) {
      expect(secretLabels.has(key), key).toBe(true)
    }
  })
})
