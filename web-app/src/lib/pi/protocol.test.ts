import { describe, expect, it } from 'vitest'
import {
  convertThreadMessageToUIMessage,
  extractContentPartsFromUIMessage,
} from '@/lib/messages'
import { MessageStatus, type ThreadMessage } from '@janhq/core'
import {
  historyFromEntries,
  messageToUi,
  reducePiEvent,
  type PiEvent,
} from './protocol'
import { filterSidebarHistoryThreads } from '@/lib/sidebar-thread-mode'
import {
  currentModeHome,
  projectDestination,
  threadRoute,
  useChatMode,
} from './navigation'
import { presentTool } from '@/lib/tools/registry'

describe('pi RPC transcripts', () => {
  const call = {
    type: 'toolCall',
    id: 'one',
    name: 'bash',
    arguments: { command: 'echo ok' },
  }
  const message = {
    role: 'assistant',
    timestamp: 42,
    content: [{ type: 'thinking', thinking: 'Consider' }, call],
  }
  it('displays the skill invocation while retaining the arguments and attachments', () => {
    const content = [
      {
        type: 'text',
        text: '<skill name="records" location="/data/skills/records/SKILL.md">\nReferences are relative to /data/skills/records.\n\nLong skill body\n</skill>\n\nLook up 42',
      },
      { type: 'image', data: 'AA==', mimeType: 'image/png' },
    ]
    expect(
      messageToUi({ role: 'user', timestamp: 1, content }, 'user')?.parts
    ).toMatchObject([
      { type: 'text', text: '/records Look up 42' },
      { type: 'file' },
    ])
  })
  it('streams indexed deltas, command output and denials', () => {
    let messages = reducePiEvent([], {
      type: 'message_start',
      message: { ...message, content: [] },
    })
    for (const [type, delta] of [
      ['thinking_start', ''],
      ['thinking_delta', 'Con'],
      ['thinking_delta', 'sider'],
    ]) {
      messages = reducePiEvent(messages, {
        type: 'message_update',
        assistantMessageEvent: { type, contentIndex: 0, delta },
      })
    }
    expect(messages[0].parts[0]).toMatchObject({
      type: 'reasoning',
      text: 'Consider',
    })
    messages = reducePiEvent(messages, {
      type: 'message_update',
      assistantMessageEvent: {
        type: 'toolcall_end',
        contentIndex: 1,
        toolCall: call,
      },
    })
    const result = { content: [{ type: 'text', text: 'working' }] }
    const update: PiEvent = {
      type: 'tool_execution_update',
      toolCallId: 'one',
      partialResult: result,
    }
    expect(reducePiEvent(messages, update)[0].parts[1]).toMatchObject({
      state: 'input-available',
      output: 'working',
    })
    const failed = reducePiEvent(messages, {
      type: 'tool_execution_end',
      toolCallId: 'one',
      result,
      isError: true,
    })
    expect(failed[0].parts[1]).toMatchObject({
      state: 'output-error',
      errorText: 'working',
    })
    expect(messages[0].parts[1]).not.toHaveProperty('errorText')
  })
  it('restores ordered reasoning and a denied tool with the same entry ID from stored chat messages', () => {
    const [ui] = historyFromEntries([
      { id: 'first', type: 'message', message },
      {
        id: 'second',
        type: 'message',
        message: {
          role: 'toolResult',
          timestamp: 43,
          toolCallId: 'one',
          isError: true,
          content: [{ type: 'text', text: 'declined' }],
        },
      },
    ])
    const row: ThreadMessage = {
      id: ui.id,
      role: 'assistant' as ThreadMessage['role'],
      object: 'thread.message',
      thread_id: 'thread',
      status: MessageStatus.Ready,
      created_at: 42,
      completed_at: 42,
      content: extractContentPartsFromUIMessage(ui),
    }
    expect(convertThreadMessageToUIMessage(row)).toMatchObject({
      id: 'first',
      parts: ui.parts,
    })
  })
  it('routes existing chats and tasks to their own views', () => {
    const old = { id: 'old', metadata: {} } as Thread
    const agent = { id: 'one', metadata: { kind: 'agent' } } as Thread
    expect(threadRoute(old)).toBe('/threads/$threadId')
    expect(threadRoute(agent)).toBe('/agent/$threadId')
    expect(filterSidebarHistoryThreads([agent, old], 'chat')).toEqual([old])
    expect(filterSidebarHistoryThreads([agent, old], 'agent')).toEqual([agent])
  })
  it('shows individual removed and added lines and bounds large writes', () => {
    const edit = presentTool({
      toolName: 'edit',
      state: 'input-available',
      input: { path: 'a', edits: [{ oldText: 'old', newText: 'new\nmore' }] },
    })
    expect(edit).toMatchObject({
      kind: 'pi_file',
      lines: [
        { kind: 'remove', text: 'old' },
        { kind: 'add', text: 'new' },
        { kind: 'add', text: 'more' },
      ],
    })
    const write = presentTool({
      toolName: 'write',
      state: 'input-available',
      input: { content: 'line\n'.repeat(50000) },
    })
    expect(write.kind === 'pi_file' && write.lines.length).toBe(501)
  })
})

it('opens the selected home and preserves the project identity in either mode', () => {
  useChatMode.getState().select('agent')
  expect(currentModeHome()).toBe('/agent')
  useChatMode.getState().select('chat')
  expect(currentModeHome()).toBe('/')
  expect(projectDestination('shared', 'chat')).toEqual({
    to: '/project/$projectId',
    params: { projectId: 'shared' },
    search: {},
  })
  expect(projectDestination('shared', 'agent')).toEqual({
    to: '/project/$projectId',
    params: { projectId: 'shared' },
    search: { mode: 'agent' },
  })
})
