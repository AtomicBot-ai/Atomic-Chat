import { describe, expect, it, vi } from 'vitest'

import {
  executeChatToolCalls,
  hasUnresolvedToolCallParts,
  shouldSendToolFollowUp,
  type ChatToolCall,
  type ChatToolOutput,
} from '../execute-chat-tool-calls'
import type { UIMessage } from '@ai-sdk/react'

const calls: ChatToolCall[] = [
  { toolCallId: 'call-1', toolName: 'search', input: { query: 'alpha' } },
  { toolCallId: 'call-2', toolName: 'search', input: { query: 'beta' } },
]

const baseOptions = () => ({
  threadId: 'thread-1',
  ragToolNames: new Set<string>(),
  mcpToolNames: new Set(['search']),
  approve: vi.fn().mockResolvedValue(true),
  callRagTool: vi.fn(),
  getProjectId: vi.fn(),
  processOutput: vi.fn(async (content) => content),
  onError: vi.fn(),
})

describe('executeChatToolCalls', () => {
  it('executes MCP calls in order and adds output for continuation', async () => {
    const events: string[] = []
    const callMcpTool = vi.fn(async ({ arguments: input }) => {
      events.push(`call:${(input as { query: string }).query}`)
      return { content: [{ type: 'text', text: 'result' }] }
    })
    const outputs: ChatToolOutput[] = []
    const addToolOutput = vi.fn((output: ChatToolOutput) => {
      events.push(`output:${output.toolCallId}`)
      outputs.push(output)
    })

    await executeChatToolCalls({
      ...baseOptions(),
      toolCalls: calls,
      signal: new AbortController().signal,
      callMcpTool,
      addToolOutput,
    })

    expect(events).toEqual([
      'call:alpha',
      'output:call-1',
      'call:beta',
      'output:call-2',
    ])
    expect(outputs).toEqual([
      {
        tool: 'search',
        toolCallId: 'call-1',
        output: [{ type: 'text', text: 'result' }],
      },
      {
        tool: 'search',
        toolCallId: 'call-2',
        output: [{ type: 'text', text: 'result' }],
      },
    ])
  })

  it('stops before the next tool when aborted after adding output', async () => {
    const controller = new AbortController()
    const completedToolCalls: string[] = []
    const callMcpTool = vi
      .fn()
      .mockResolvedValue({ content: [{ type: 'text', text: 'result' }] })
    const addToolOutput = vi.fn((output: ChatToolOutput) => {
      completedToolCalls.push(output.toolCallId)
      controller.abort()
    })

    await executeChatToolCalls({
      ...baseOptions(),
      toolCalls: calls,
      signal: controller.signal,
      callMcpTool,
      addToolOutput,
    })

    expect(completedToolCalls).toEqual(['call-1'])
  })

  it('reports denial without calling a service', async () => {
    const options = baseOptions()
    options.approve.mockResolvedValue(false)
    const callMcpTool = vi.fn()
    const outputs: ChatToolOutput[] = []
    const addToolOutput = vi.fn((output: ChatToolOutput) =>
      outputs.push(output)
    )

    await executeChatToolCalls({
      ...options,
      toolCalls: [calls[0]],
      signal: new AbortController().signal,
      callMcpTool,
      addToolOutput,
    })

    expect(callMcpTool).not.toHaveBeenCalled()
    expect(outputs).toEqual([
      {
        state: 'output-error',
        tool: 'search',
        toolCallId: 'call-1',
        errorText: 'Tool execution denied by user',
      },
    ])
  })
})

describe('executeChatToolCalls with commands', () => {
  const runCall: ChatToolCall = {
    toolCallId: 'call-run',
    toolName: 'run_command',
    input: { command: 'ls' },
  }

  it('runs an approved command itself, even when an MCP tool has the same name', async () => {
    const controller = new AbortController()
    const callMcpTool = vi.fn()
    const callExecTool = vi.fn().mockResolvedValue({
      output: { kind: 'chat-exec', text: 'Exit code: 0' },
    })
    const outputs: ChatToolOutput[] = []

    await executeChatToolCalls({
      ...baseOptions(),
      mcpToolNames: new Set(['run_command']),
      execToolNames: new Set(['run_command', 'run_script']),
      toolCalls: [runCall],
      signal: controller.signal,
      callMcpTool,
      callExecTool,
      addToolOutput: (output) => outputs.push(output),
    })

    expect(callMcpTool).not.toHaveBeenCalled()
    expect(callExecTool).toHaveBeenCalledWith({
      toolCallId: 'call-run',
      toolName: 'run_command',
      input: { command: 'ls' },
      threadId: 'thread-1',
      signal: controller.signal,
    })
    expect(outputs).toEqual([
      {
        tool: 'run_command',
        toolCallId: 'call-run',
        output: { kind: 'chat-exec', text: 'Exit code: 0' },
      },
    ])
  })

  it('reports a command the backend refused as a tool error', async () => {
    const outputs: ChatToolOutput[] = []

    await executeChatToolCalls({
      ...baseOptions(),
      execToolNames: new Set(['run_command']),
      toolCalls: [runCall],
      signal: new AbortController().signal,
      callMcpTool: vi.fn(),
      callExecTool: vi.fn().mockResolvedValue({ error: 'Nothing to run' }),
      addToolOutput: (output) => outputs.push(output),
    })

    expect(outputs).toEqual([
      {
        state: 'output-error',
        tool: 'run_command',
        toolCallId: 'call-run',
        errorText: 'Error: Nothing to run',
      },
    ])
  })

  it('never runs a denied command', async () => {
    const options = baseOptions()
    options.approve.mockResolvedValue(false)
    const callExecTool = vi.fn()
    const outputs: ChatToolOutput[] = []

    await executeChatToolCalls({
      ...options,
      execToolNames: new Set(['run_command']),
      toolCalls: [runCall],
      signal: new AbortController().signal,
      callMcpTool: vi.fn(),
      callExecTool,
      addToolOutput: (output) => outputs.push(output),
    })

    expect(callExecTool).not.toHaveBeenCalled()
    expect(outputs).toEqual([
      {
        state: 'output-error',
        tool: 'run_command',
        toolCallId: 'call-run',
        errorText: 'Tool execution denied by user',
      },
    ])
  })
})

describe('shouldSendToolFollowUp', () => {
  const completedToolMessage = {
    id: 'assistant-1',
    role: 'assistant',
    parts: [
      {
        type: 'tool-search',
        toolCallId: 'call-1',
        state: 'output-available',
        input: { query: 'alpha' },
        output: { ok: true },
      },
    ],
  } as UIMessage

  it('continues after complete tool output while the loop is active', () => {
    expect(
      shouldSendToolFollowUp([completedToolMessage], new AbortController())
    ).toBe(true)
  })

  it('does not continue after the tool loop is aborted', () => {
    const controller = new AbortController()
    controller.abort()

    expect(shouldSendToolFollowUp([completedToolMessage], controller)).toBe(
      false
    )
    expect(shouldSendToolFollowUp([completedToolMessage], null)).toBe(false)
  })
})

// The thread page's terminal check (PR #335, ATO-538): the finished message is
// the judge, not a tool queue that can keep entries from an earlier step.
describe('hasUnresolvedToolCallParts', () => {
  const messageWithParts = (parts: UIMessage['parts']) =>
    ({ id: 'assistant-1', role: 'assistant', parts }) as UIMessage

  it('flags a tool call that is still waiting on its output', () => {
    expect(
      hasUnresolvedToolCallParts(
        messageWithParts([
          { type: 'text', text: 'Working on it' },
          {
            type: 'tool-search',
            toolCallId: 'call-1',
            state: 'input-available',
            input: { query: 'alpha' },
          },
        ])
      )
    ).toBe(true)
  })

  it('counts a failed tool call as resolved — the error output is delivered', () => {
    expect(
      hasUnresolvedToolCallParts(
        messageWithParts([
          {
            type: 'tool-search',
            toolCallId: 'call-1',
            state: 'output-error',
            input: { query: 'alpha' },
            errorText: 'boom',
          },
        ])
      )
    ).toBe(false)
  })

  it('treats answered tool calls plus a final text as terminal', () => {
    expect(
      hasUnresolvedToolCallParts(
        messageWithParts([
          {
            type: 'tool-search',
            toolCallId: 'call-1',
            state: 'output-available',
            input: { query: 'alpha' },
            output: { ok: true },
          },
          { type: 'text', text: 'All done' },
        ])
      )
    ).toBe(false)
  })

  it('treats a plain answer with no tool parts as terminal', () => {
    expect(
      hasUnresolvedToolCallParts(
        messageWithParts([{ type: 'text', text: 'EDIT_OK' }])
      )
    ).toBe(false)
  })
})
