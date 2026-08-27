import { describe, it, expect } from 'vitest'
import {
  MCP_CONNECTORS,
  findInstalledServer,
  buildConnectorConfig,
} from '../mcp-connectors'
import type { MCPServers } from '@/hooks/useMCPServers'

const exa = MCP_CONNECTORS.find((c) => c.serverKey === 'exa')!
const serper = MCP_CONNECTORS.find((c) => c.serverKey === 'serper')!
const fetchConnector = MCP_CONNECTORS.find((c) => c.serverKey === 'fetch')!

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
    expect(findInstalledServer(fetchConnector, servers)).toBeUndefined()
  })
})

describe('buildConnectorConfig', () => {
  it('injects an env secret without mutating the template', async () => {
    const config = await buildConnectorConfig(serper, 'my-key')
    expect(config.env.SERPER_API_KEY).toBe('my-key')
    expect(serper.config.env.SERPER_API_KEY).toBeUndefined()
  })

  it('trims the secret and skips empty values', async () => {
    const config = await buildConnectorConfig(serper, '  ')
    expect(config.env.SERPER_API_KEY).toBeUndefined()
  })

  it('injects a header secret with formatting', async () => {
    const connector = {
      ...serper,
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
})
