import { describe, expect, it } from 'vitest'
import type { UIMessage } from 'ai'
import { buildTraceBlocks } from './message-trace-parts'

describe('buildTraceBlocks activity projection', () => {
  it('renders reasoning above the compact activity block', () => {
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

    expect(blocks).toHaveLength(3)
    expect(blocks[0]).toMatchObject({
      kind: 'reasoning',
      streaming: false,
      items: [{ text: 'Inspect the workspace.' }],
    })
    expect(blocks[1]).toMatchObject({
      kind: 'activity',
      durationMs: 2_400,
      tools: [{ toolName: 'mcp.search', state: 'output-available' }],
    })
    expect(blocks[2]).toMatchObject({ kind: 'text', text: 'Done.' })
  })

  it('keeps reasoning streaming until the answer text starts', () => {
    const message = {
      id: 'assistant-thinking',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'Still weighing options.' }],
    } as UIMessage

    expect(buildTraceBlocks(message, false)).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: true }),
    ])
  })

  it('drops reasoning entirely when the global toggle disables it', () => {
    const message = {
      id: 'assistant-no-reasoning',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Hidden thought.' },
        { type: 'text', text: 'Answer.' },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message, true)).toEqual([
      expect.objectContaining({ kind: 'text', text: 'Answer.' }),
    ])
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

  it('creates one live activity block before Chat emits any parts', () => {
    const message = {
      id: 'assistant-live',
      role: 'assistant',
      parts: [],
    } as UIMessage

    expect(buildTraceBlocks(message, false, { ensureActivity: true })).toEqual([
      expect.objectContaining({
        kind: 'activity',
        tools: [],
      }),
    ])
  })

  it('keeps a completed text-only Chat activity from duration metadata', () => {
    const message = {
      id: 'assistant-complete',
      role: 'assistant',
      metadata: { activityDurationMs: 1_500 },
      parts: [{ type: 'text', text: 'Complete.' }],
    } as UIMessage

    expect(buildTraceBlocks(message, false)).toEqual([
      expect.objectContaining({
        kind: 'activity',
        durationMs: 1_500,
      }),
      expect.objectContaining({
        kind: 'text',
        text: 'Complete.',
      }),
    ])
  })

  it('excludes terminal tools from visible activity rows', () => {
    const message = {
      id: 'assistant-terminal',
      role: 'assistant',
      metadata: { activityDurationMs: 800 },
      parts: [
        {
          type: 'tool-reply',
          toolCallId: 'tool-reply',
          state: 'output-available',
          input: { text: 'Done.' },
          output: { ok: true },
        },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message, false)).toEqual([
      expect.objectContaining({
        kind: 'activity',
        tools: [],
      }),
    ])
  })
})
