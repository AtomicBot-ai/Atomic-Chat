import { describe, expect, it } from 'vitest'
import { presentGenericTool } from './generic'

describe('presentGenericTool', () => {
  it('describes Agent filesystem actions in plain English', () => {
    expect(
      presentGenericTool({
        toolName: 'os.fs.mkdir',
        input: { path: 'Desktop/qwe' },
        state: 'output-available',
      })
    ).toMatchObject({
      title: 'Created folder',
      subtitle: 'Desktop/qwe',
    })
  })

  it('uses an active verb while an action is running', () => {
    expect(
      presentGenericTool({
        toolName: 'os.web.search',
        input: { query: 'USD RUB exchange rate' },
        state: 'input-available',
      })
    ).toMatchObject({
      title: 'Searching the web',
      subtitle: 'USD RUB exchange rate',
    })
  })

  it('names the specialist a task was handed to', () => {
    expect(
      presentGenericTool({
        toolName: 'agent.delegate',
        input: { specialist: 'Network', task: 'Why is the Wi-Fi slow?' },
        state: 'input-available',
      })
    ).toMatchObject({
      title: 'Asking specialist',
      subtitle: 'Network',
    })
  })

  it('names the network check and its target', () => {
    expect(
      presentGenericTool({
        toolName: 'net.ping',
        input: { host: '192.168.1.1', count: 4 },
        state: 'output-available',
      })
    ).toMatchObject({ title: 'Pinged', subtitle: '192.168.1.1' })
    expect(
      presentGenericTool({
        toolName: 'net.set_dns',
        input: { adapter: 'Wi-Fi', servers: ['1.1.1.1'] },
        state: 'input-available',
      })
    ).toMatchObject({ title: 'Changing DNS servers', subtitle: 'Wi-Fi' })
  })

  it('humanizes unknown MCP tool names', () => {
    expect(
      presentGenericTool({
        toolName: 'mcp.search_documents',
        state: 'output-available',
      }).title
    ).toBe('Called Search Documents')
  })
})
