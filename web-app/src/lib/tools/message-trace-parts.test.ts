import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { buildTraceBlocks } from './message-trace-parts'

describe('buildTraceBlocks activity projection', () => {
  it('groups reasoning and tool calls into one compact activity block', () => {
    const message = {
      id: 'assistant-1',
      role: 'assistant',
      metadata: { activityDurationMs: 2_400 },
      parts: [
        { type: 'reasoning', text: 'Inspect the workspace.' },
        {
          type: 'tool-mcp.search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: { query: 'Atomic Chat' },
          output: { ok: true },
        },
        { type: 'text', text: 'Done.' },
      ],
    } as UIMessage

    const blocks = buildTraceBlocks(message, false)

    expect(blocks).toHaveLength(2)
    expect(blocks[0]).toMatchObject({
      kind: 'activity',
      durationMs: 2_400,
      reasoning: [{ text: 'Inspect the workspace.' }],
      tools: [{ toolName: 'mcp.search', state: 'output-available' }],
    })
    expect(blocks[1]).toMatchObject({ kind: 'text', text: 'Done.' })
  })

  it('keeps an agent activity block when the run has no tool yet', () => {
    const message = {
      id: 'agent-run-1',
      role: 'assistant',
      metadata: {
        agent_run: {
          run_id: 'run-1',
          status: 'running',
          tools: [],
          loops: [],
        },
      },
      parts: [],
    } as UIMessage

    expect(buildTraceBlocks(message, false)).toEqual([
      expect.objectContaining({
        kind: 'activity',
        agentSummary: expect.objectContaining({ status: 'running' }),
      }),
    ])
  })
})
