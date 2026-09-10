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

  it('humanizes unknown MCP tool names', () => {
    expect(
      presentGenericTool({
        toolName: 'mcp.search_documents',
        state: 'output-available',
      }).title
    ).toBe('Called Search Documents')
  })
})
