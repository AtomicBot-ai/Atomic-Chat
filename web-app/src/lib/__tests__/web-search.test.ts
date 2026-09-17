import { describe, it, expect } from 'vitest'
import { findWebSearchServer, isWebSearchEnabled } from '../web-search'

const http = (url: string, active = false) => ({
  command: '',
  args: [],
  env: {},
  type: 'http' as const,
  url,
  active,
})

describe('findWebSearchServer', () => {
  it('finds nothing when no search server is configured', () => {
    expect(
      findWebSearchServer({ filesystem: { command: 'npx', args: [], env: {} } })
    ).toBeUndefined()
  })

  it('prefers the active server over the better-known one', () => {
    const found = findWebSearchServer({
      exa: http('https://mcp.exa.ai/mcp'),
      serper: { command: 'npx', args: [], env: {}, active: true },
    })

    expect(found?.key).toBe('serper')
  })

  it('falls back to the preferred server when none is active', () => {
    const found = findWebSearchServer({
      tavily: { command: 'npx', args: [], env: {} },
      exa: http('https://mcp.exa.ai/mcp'),
    })

    expect(found?.key).toBe('exa')
  })

  it('recognizes a renamed Exa endpoint by its url', () => {
    const found = findWebSearchServer({
      'my-search': http('https://mcp.exa.ai/mcp', true),
    })

    expect(found?.key).toBe('my-search')
  })
})

describe('web search availability shared with agent requests', () => {
  const server = { key: 'exa', config: http('https://mcp.exa.ai/mcp', true) }
  const tool = {
    server: 'exa',
    name: 'web_search_exa',
    description: '',
    inputSchema: {},
  }

  it('keeps the per-turn flag off when startup returned no search tools', () => {
    expect(isWebSearchEnabled(server, [], [], [])).toBe(false)
    expect(
      isWebSearchEnabled(server, [{ ...tool, name: 'web_fetch_exa' }], [], [])
    ).toBe(false)
  })

  it('enables the flag only for an active, discovered, unmuted search tool', () => {
    expect(isWebSearchEnabled(server, [tool], [], [])).toBe(true)
    expect(
      isWebSearchEnabled(server, [tool], ['exa::web_search_exa'], [])
    ).toBe(false)
    expect(isWebSearchEnabled(server, [tool], [], ['exa'])).toBe(false)
    expect(
      isWebSearchEnabled(
        { ...server, config: { ...server.config, active: false } },
        [tool],
        [],
        []
      )
    ).toBe(false)
  })
})
