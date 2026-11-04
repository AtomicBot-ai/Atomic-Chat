import { Chat } from '@ai-sdk/react'
import {
  lastAssistantMessageIsCompleteWithToolCalls,
  type ChatTransport,
  type UIMessage,
  type UIMessageChunk,
} from 'ai'
import { describe, expect, it, vi } from 'vitest'
import { convertThreadMessageToUIMessage } from '@/lib/messages'
import { formatTransportError } from '@/lib/transport-error'
import { finishedAssistantMessage, turnErrorOf } from '@/lib/turn-error'
import { isEngineGoneError, planEngineRecovery } from '@/lib/turn-recovery'

// The real AI SDK Chat drives the turn; only the transport is scripted. The
// failed turn is stored and held in the Chat the way the thread page's
// onFinish does it, so the recovery runs on the same messages it would see.

const ENGINE_RESET = formatTransportError(
  'connection_reset',
  'Stream error: An existing connection was forcibly closed by the remote host. (os error 10054)'
)

function streamOf(chunks: UIMessageChunk[]): ReadableStream<UIMessageChunk> {
  return new ReadableStream({
    start(controller) {
      for (const chunk of chunks) controller.enqueue(chunk)
      controller.close()
    },
  })
}

const text = (id: string, delta: string): UIMessageChunk[] => [
  { type: 'text-start', id },
  { type: 'text-delta', id, delta },
  { type: 'text-end', id },
]

function scriptedChat(script: UIMessageChunk[][]) {
  const requests: UIMessage[][] = []
  const transport: ChatTransport<UIMessage> = {
    sendMessages: async ({ messages }) => {
      requests.push(structuredClone(messages))
      const chunks = script[requests.length - 1]
      if (!chunks) throw new Error(`unexpected request #${requests.length}`)
      return streamOf(chunks)
    },
    reconnectToStream: async () => null,
  }
  const toolRuns: string[] = []
  const chat: Chat<UIMessage> = new Chat<UIMessage>({
    id: 'thread-1',
    transport,
    sendAutomaticallyWhen: lastAssistantMessageIsCompleteWithToolCalls,
    onToolCall: ({ toolCall }) => {
      // Tools run after their step, as the thread page runs them.
      queueMicrotask(() => {
        toolRuns.push(toolCall.toolCallId)
        void chat.addToolOutput({
          tool: toolCall.toolName,
          toolCallId: toolCall.toolCallId,
          output: { hits: 1 },
        })
      })
    },
    onFinish: ({ message, isAbort, isError }) => {
      if (!isError) return
      // `$threadId.tsx` onFinish: store the failed turn and hold it in the
      // Chat as a reload would show it.
      const stored = finishedAssistantMessage({
        message,
        threadId: 'thread-1',
        isAbort,
        isError,
        error: chat.error,
      })!
      chat.messages = [
        ...chat.messages.filter((m) => m.id !== message.id),
        convertThreadMessageToUIMessage(stored),
      ]
    },
  })
  return { chat, requests, toolRuns }
}

const userMessage = {
  text: 'What is in the repo?',
  files: [
    {
      type: 'file' as const,
      mediaType: 'image/png',
      url: 'data:image/png;base64,AAAA',
    },
  ],
}

describe('engine-gone recovery with a real Chat', () => {
  it('resumes after a finished tool call: the tool runs once and the turn ends with one answer', async () => {
    const { chat, requests, toolRuns } = scriptedChat([
      // Step 1 asks for a tool.
      [
        { type: 'start' },
        { type: 'start-step' },
        ...text('t1', 'Let me look.'),
        {
          type: 'tool-input-available',
          toolCallId: 'call-1',
          toolName: 'search',
          input: { q: 'repo' },
        },
        { type: 'finish-step' },
        { type: 'finish' },
      ],
      // Step 2 (the automatic follow-up with the tool result): the engine dies.
      [
        { type: 'start-step' },
        ...text('t2', 'The repo has'),
        { type: 'error', errorText: ENGINE_RESET },
      ],
      // The recovery's continuation.
      [
        { type: 'start' },
        { type: 'start-step' },
        ...text('t3', 'The repo has a web app.'),
        { type: 'finish-step' },
        { type: 'finish' },
      ],
    ])

    await chat.sendMessage(userMessage)
    await vi.waitFor(() => expect(chat.status).toBe('error'))
    expect(isEngineGoneError(chat.error)).toBe(true)

    const plan = planEngineRecovery({ messages: chat.messages })
    expect(plan?.kind).toBe('resume')
    if (plan?.kind !== 'resume') return
    expect(plan.reusedToolCallIds).toEqual(['call-1'])

    chat.messages = plan.messages
    await chat.sendMessage()
    await vi.waitFor(() => expect(chat.status).toBe('ready'))

    expect(toolRuns).toEqual(['call-1'])
    expect(requests).toHaveLength(3)
    // The continuation sent the tool's result back instead of asking again.
    const resumedRequest = requests[2]
    expect(resumedRequest.at(-1)?.parts).toContainEqual(
      expect.objectContaining({
        toolCallId: 'call-1',
        state: 'output-available',
        output: { hits: 1 },
      })
    )

    const [user, ...rest] = chat.messages
    // The user's message and its attachment are where they were.
    expect(user.role).toBe('user')
    expect(user.parts).toContainEqual(
      expect.objectContaining({ type: 'file', mediaType: 'image/png' })
    )
    // One answer: the failed assistant message, continued.
    expect(rest).toHaveLength(1)
    const answer = rest[0]
    expect(answer.id).toBe(plan.failedMessageId)
    expect(turnErrorOf(answer)).toBeUndefined()
    const texts = answer.parts
      .filter((part) => part.type === 'text')
      .map((part) => (part as { text: string }).text)
    expect(texts).toEqual(['Let me look.', 'The repo has a web app.'])
  })

  it('regenerates a turn that ran no tools: one answer replaces the failed one', async () => {
    const { chat, requests, toolRuns } = scriptedChat([
      [
        { type: 'start' },
        { type: 'start-step' },
        ...text('t1', 'Half an ans'),
        { type: 'error', errorText: ENGINE_RESET },
      ],
      [
        { type: 'start' },
        { type: 'start-step' },
        ...text('t2', 'A whole answer.'),
        { type: 'finish-step' },
        { type: 'finish' },
      ],
    ])

    await chat.sendMessage(userMessage)
    await vi.waitFor(() => expect(chat.status).toBe('error'))
    const plan = planEngineRecovery({ messages: chat.messages })
    expect(plan).toMatchObject({ kind: 'regenerate' })
    if (plan?.kind !== 'regenerate') return

    await chat.regenerate({ messageId: plan.failedMessageId })
    await vi.waitFor(() => expect(chat.status).toBe('ready'))

    expect(toolRuns).toEqual([])
    expect(requests).toHaveLength(2)
    expect(requests[1].map((m) => m.role)).toEqual(['user'])
    expect(chat.messages.map((m) => m.role)).toEqual(['user', 'assistant'])
    expect(chat.messages[0].parts).toContainEqual(
      expect.objectContaining({ type: 'file', mediaType: 'image/png' })
    )
    expect(
      chat.messages[1].parts.filter((part) => part.type === 'text')
    ).toEqual([expect.objectContaining({ text: 'A whole answer.' })])
  })
})
