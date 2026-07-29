import { describe, expect, it, vi } from 'vitest'

import {
  executeChatToolCalls,
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
