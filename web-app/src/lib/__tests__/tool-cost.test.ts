import { describe, expect, it } from 'vitest'
import type { MCPTool } from '@/types/completion'
import {
  HEAVY_SERVER_CTX_SHARE,
  HEAVY_TOOLS_CTX_SHARE,
  estimateMcpToolTokens,
  formatTokenCount,
  summarizeToolCost,
} from '../tool-cost'

const tool = (server: string, name: string, descriptionChars = 40): MCPTool => ({
  server,
  name,
  description: 'd'.repeat(descriptionChars),
  inputSchema: {
    type: 'object',
    properties: { q: { type: 'string', description: 'x'.repeat(20) } },
  },
})

describe('summarizeToolCost', () => {
  it('groups by server, sorts largest first and sums the total', () => {
    const tools = [
      tool('exa', 'search'),
      tool('linear', 'list_issues', 400),
      tool('linear', 'save_issue', 400),
    ]
    const report = summarizeToolCost(tools, undefined)

    expect(report.toolCount).toBe(3)
    expect(report.perServer.map((s) => s.server)).toEqual(['linear', 'exa'])
    expect(report.perServer[0].toolCount).toBe(2)
    expect(report.totalTokens).toBe(
      tools.reduce((sum, t) => sum + estimateMcpToolTokens(t), 0)
    )
    // No context window → no shares, nothing flagged.
    expect(report.ctxShare).toBeUndefined()
    expect(report.heavyServers).toEqual([])
    expect(report.tooHeavy).toBe(false)
  })

  it('flags a connector over the per-server share and the total over its share', () => {
    const linear = Array.from({ length: 70 }, (_, i) =>
      tool('linear', `tool_${i}`, 300)
    )
    const report = summarizeToolCost([...linear, tool('exa', 'search')], 16384)

    const linearCost = report.perServer.find((s) => s.server === 'linear')!
    expect(linearCost.ctxShare).toBeGreaterThan(HEAVY_SERVER_CTX_SHARE)
    expect(linearCost.heavy).toBe(true)
    expect(report.heavyServers).toEqual(['linear'])
    expect(report.ctxShare).toBeGreaterThan(HEAVY_TOOLS_CTX_SHARE)
    expect(report.tooHeavy).toBe(true)

    const exa = report.perServer.find((s) => s.server === 'exa')!
    expect(exa.heavy).toBe(false)
  })

  it('stays quiet for a small tool set on a big window', () => {
    const report = summarizeToolCost([tool('exa', 'search')], 32768)
    expect(report.heavyServers).toEqual([])
    expect(report.tooHeavy).toBe(false)
    expect(report.ctxShare).toBeLessThan(0.01)
  })

  it('never mutates or drops tools', () => {
    const tools = [tool('a', 'x'), tool('b', 'y')]
    const snapshot = JSON.stringify(tools)
    summarizeToolCost(tools, 8192)
    expect(JSON.stringify(tools)).toBe(snapshot)
  })
})

describe('formatTokenCount', () => {
  it('formats compactly', () => {
    expect(formatTokenCount(512)).toBe('512')
    expect(formatTokenCount(1536)).toBe('1.5k')
    expect(formatTokenCount(18432)).toBe('18k')
  })
})
