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

    const blocks = buildTraceBlocks(message)

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

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: true }),
    ])
  })

  it('keeps a stored reasoning part whatever the global toggle says', () => {
    // The effort setting applies to the next request, never to a message
    // that already carries reasoning: the transcript must not change when
    // the composer's effort slider moves.
    const message = {
      id: 'assistant-kept-reasoning',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Kept thought.', state: 'done' },
        { type: 'text', text: 'Answer.' },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({
        kind: 'reasoning',
        streaming: false,
        items: [{ key: 'assistant-kept-reasoning-0', text: 'Kept thought.' }],
      }),
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

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({
        kind: 'activity',
        agentSummary: expect.objectContaining({ status: 'running' }),
      }),
    ])
  })

  it('keeps Working visible while reasoning is still streaming', () => {
    const message = {
      id: 'assistant-reasoning-live',
      role: 'assistant',
      parts: [
        {
          type: 'reasoning',
          text: 'Sketching the pelican.',
          state: 'streaming',
        },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message, { ensureActivity: true })).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: true }),
      expect.objectContaining({ kind: 'activity', tools: [] }),
    ])
  })

  it('keeps the live activity after a reasoning part finishes', () => {
    const message = {
      id: 'assistant-reasoning-done',
      role: 'assistant',
      parts: [{ type: 'reasoning', text: 'Planned it out.', state: 'done' }],
    } as UIMessage

    expect(buildTraceBlocks(message, { ensureActivity: true })).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: false }),
      expect.objectContaining({ kind: 'activity', tools: [] }),
    ])
  })

  it('keeps a tool-backed activity visible while reasoning streams', () => {
    const message = {
      id: 'assistant-reasoning-tools',
      role: 'assistant',
      parts: [
        { type: 'reasoning', text: 'Checking sources.', state: 'streaming' },
        {
          type: 'tool-mcp.search',
          toolCallId: 'tool-1',
          state: 'input-available',
          input: { query: 'pelican' },
        },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message, { ensureActivity: true })).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: true }),
      expect.objectContaining({
        kind: 'activity',
        tools: [expect.objectContaining({ toolName: 'mcp.search' })],
      }),
    ])
  })

  it('creates one live activity block before Chat emits any parts', () => {
    const message = {
      id: 'assistant-live',
      role: 'assistant',
      parts: [],
    } as UIMessage

    expect(buildTraceBlocks(message, { ensureActivity: true })).toEqual([
      expect.objectContaining({
        kind: 'activity',
        tools: [],
      }),
    ])
  })

  // ATO-534: with nothing to expand, the finished block was a bare
  // "Worked for 2.9s" stacked under "Thought for 2s" — the same fact twice.
  it('drops a finished Chat activity that only carries its duration', () => {
    const message = {
      id: 'assistant-complete',
      role: 'assistant',
      metadata: { activityDurationMs: 1_500 },
      parts: [
        { type: 'reasoning', text: 'Say hi back.', state: 'done' },
        { type: 'text', text: 'Complete.' },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({ kind: 'reasoning', streaming: false }),
      expect.objectContaining({ kind: 'text', text: 'Complete.' }),
    ])
  })

  it('keeps a finished activity that has tool calls behind it', () => {
    const message = {
      id: 'assistant-tools-complete',
      role: 'assistant',
      metadata: { activityDurationMs: 2_000 },
      parts: [
        {
          type: 'tool-mcp.search',
          toolCallId: 'tool-1',
          state: 'output-available',
          input: { query: 'pelican' },
          output: { ok: true },
        },
        { type: 'text', text: 'Found it.' },
      ],
    } as UIMessage

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({ kind: 'activity', durationMs: 2_000 }),
      expect.objectContaining({ kind: 'text', text: 'Found it.' }),
    ])
  })

  it('does not count terminal tools as something to expand', () => {
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

    // Finished: the reply is the answer, so there is no step to trace.
    expect(buildTraceBlocks(message)).toEqual([])
    // Live: still a shimmer, and the reply is not a row in it.
    expect(buildTraceBlocks(message, { ensureActivity: true })).toEqual([
      expect.objectContaining({ kind: 'activity', tools: [] }),
    ])
  })

  it('keeps live activity mounted while the answer streams', () => {
    const message = {
      id: 'assistant-answer-live',
      role: 'assistant',
      parts: [{ type: 'text', text: 'Hey! How' }],
    } as UIMessage

    expect(buildTraceBlocks(message, { ensureActivity: true })).toEqual([
      expect.objectContaining({ kind: 'activity', tools: [] }),
      expect.objectContaining({ kind: 'text', text: 'Hey! How' }),
    ])
  })

  it('drops a finished agent run with nothing to expand', () => {
    const message = {
      id: 'agent-run-done',
      role: 'assistant',
      metadata: {
        agent_run: {
          run_id: 'run-2',
          status: 'finished',
          duration_ms: 1_200,
          tools: [{ tool: 'reply', batch_index: 0, batch_size: 1 }],
          loops: [],
        },
      },
      parts: [{ type: 'text', text: 'All set.' }],
    } as UIMessage

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({ kind: 'text', text: 'All set.' }),
    ])
  })

  it('keeps a failed agent run, whose error is the point', () => {
    const message = {
      id: 'agent-run-failed',
      role: 'assistant',
      metadata: {
        agent_run: {
          run_id: 'run-3',
          status: 'failed',
          tools: [],
          loops: [],
          error: { category: 'provider', message: 'Connection refused' },
        },
      },
      parts: [],
    } as UIMessage

    expect(buildTraceBlocks(message)).toEqual([
      expect.objectContaining({
        kind: 'activity',
        agentSummary: expect.objectContaining({ status: 'failed' }),
      }),
    ])
  })

  it.each(['running', 'awaiting_approval', 'awaiting_folder_access'])(
    'keeps an empty %s run live unless its caller marks it historical',
    (status) => {
      const message = {
        id: 'agent-wait',
        role: 'assistant',
        parts: [],
        metadata: {
          agent_run: { run_id: 'wait', status, tools: [], loops: [] },
        },
      } as UIMessage
      expect(buildTraceBlocks(message)).toEqual([
        expect.objectContaining({
          kind: 'activity',
          key: 'agent-wait-activity',
        }),
      ])
      expect(buildTraceBlocks(message, { ensureActivity: false })).toEqual([])
    }
  )

  it.each(['idle', 'finished', 'failed', 'cancelled'])(
    'does not invent live activity for an empty %s run',
    (status) => {
      const message = {
        id: 'agent-inactive',
        role: 'assistant',
        parts: [],
        metadata: {
          agent_run: { run_id: 'inactive', status, tools: [], loops: [] },
        },
      } as UIMessage
      expect(buildTraceBlocks(message)).toEqual([])
    }
  )
})
