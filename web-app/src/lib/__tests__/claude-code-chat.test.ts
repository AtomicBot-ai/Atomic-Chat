import { beforeEach, describe, expect, it, vi } from 'vitest'
import { webcrypto } from 'node:crypto'
import type { UIMessage, UIMessageChunk } from 'ai'
import { invoke } from '@tauri-apps/api/core'
import {
  canResumeClaude,
  streamClaudeCode,
  textTurns,
  claudeCodeProvider,
  resolveClaudeModel,
  loginClaudeCode,
} from '../claude-code-chat'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getProviderLogo } from '@/lib/utils'
import { seedServiceHub } from '@/test/service-hub'
import type { PathService } from '@/services/path/types'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: (value: unknown) => void = () => {}
  },
}))

const user = (text: string): UIMessage => ({
  id: text,
  role: 'user',
  parts: [{ type: 'text', text }],
})
const assistant = (text: string): UIMessage => ({
  id: text,
  role: 'assistant',
  parts: [{ type: 'text', text }],
})
const base = {
  threadId: 'atomic-test-thread',
  model: 'claude-code-default',
  messages: [user('hello')],
}
const sessionId = '684286da-7283-4e22-9436-c6f6c3c03015'
type Call = {
  request: { sessionId?: string; prompt: string }
  events: { onmessage: (event: unknown) => void }
}

async function collect(stream: ReadableStream<UIMessageChunk>) {
  const chunks: UIMessageChunk[] = []
  const reader = stream.getReader()
  while (true) {
    const { value, done } = await reader.read()
    if (done) break
    chunks.push(value)
  }
  return chunks
}

function mockResponse(text = 'Hello', deltas = true) {
  vi.mocked(invoke).mockImplementation(async (command, args) => {
    if (command !== 'atomic_claude_chat') return undefined as never
    const { events } = args as unknown as Call
    events.onmessage({ type: 'ready' })
    if (deltas) events.onmessage({ type: 'delta', text })
    return { sessionId, text, inputTokens: 12, outputTokens: 3 } as never
  })
}

describe('Claude Code chat transport', () => {
  it('shows the discovered catalog, updates stale labels, and migrates saved aliases', () => {
    const provider = claudeCodeProvider([
      { id: 'claude-code-default', name: 'Claude Opus 5.5 · 1M · default' },
      { id: 'claude-opus-5-5[1m]', name: 'Claude Opus 5.5 · 1M' },
      { id: 'claude-fable-5-1[1m]', name: 'Claude Fable 5.1 · 1M' },
    ])
    expect(provider.models[2].displayName).toBe('Claude Fable 5.1 · 1M')
    expect(resolveClaudeModel(provider.models, 'claude-code-opus')?.id).toBe(
      'claude-opus-5-5[1m]'
    )
    expect(claudeCodeProvider().models).toEqual([])
    useModelProvider.setState({
      providers: [
        {
          ...provider,
          models: [
            {
              id: 'claude-code-default',
              displayName: 'Claude · account default',
            },
          ],
        },
      ],
      selectedProvider: 'claude-code',
      selectedModel: { id: 'claude-code-default' },
    })
    useModelProvider.getState().setProviders([provider])
    expect(useModelProvider.getState().selectedModel?.displayName).toBe(
      'Claude Opus 5.5 · 1M · default'
    )
    expect(
      useModelProvider
        .getState()
        .selectModelProvider('claude-code', 'claude-code-opus')?.id
    ).toBe('claude-opus-5-5[1m]')
    expect(getProviderLogo('claude-code')).toBe(
      '/images/model-provider/claude.svg'
    )
  })
  beforeEach(() => {
    seedServiceHub({ path: { sep: () => '/' } as PathService })
    vi.clearAllMocks()
    localStorage.clear()
    vi.stubGlobal('crypto', webcrypto)
    mockResponse()
  })

  it('streams once, completes the UI protocol, and reports token usage', async () => {
    const onTokenUsage = vi.fn()
    const chunks = await collect(
      await streamClaudeCode({ ...base, onTokenUsage })
    )
    expect(chunks.map((c) => c.type)).toEqual([
      'start',
      'text-start',
      'text-delta',
      'text-end',
      'finish',
    ])
    expect(onTokenUsage).toHaveBeenCalledWith(
      { inputTokens: 12, outputTokens: 3, totalTokens: 15 },
      expect.any(String)
    )
  })

  it('uses final output when the CLI sends no text deltas', async () => {
    mockResponse('Final only', false)
    const chunks = await collect(await streamClaudeCode(base))
    expect(chunks.find((c) => c.type === 'text-delta')).toMatchObject({
      delta: 'Final only',
    })
  })

  it('resumes only an exact completed conversation and keeps threads isolated', async () => {
    await collect(await streamClaudeCode(base))
    const messages = [user('hello'), assistant('Hello'), user('next')]
    await collect(await streamClaudeCode({ ...base, messages }))
    expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({
      request: { sessionId, prompt: 'next' },
    })
    await collect(
      await streamClaudeCode({ ...base, threadId: 'another-thread', messages })
    )
    expect(vi.mocked(invoke).mock.calls[2][1]).toMatchObject({
      request: { sessionId: null },
    })
  })

  it('rebuilds history when regenerating, editing, or switching model or system prompt', async () => {
    const binding = {
      sessionId,
      model: 'opus',
      system: 'system',
      history: 'digest',
    }
    expect(canResumeClaude(binding, 'opus', 'system', 'digest')).toBe(true)
    expect(canResumeClaude(binding, 'sonnet', 'system', 'digest')).toBe(false)
    expect(canResumeClaude(binding, 'opus', 'changed', 'digest')).toBe(false)
    expect(canResumeClaude(binding, 'opus', 'system', 'edited')).toBe(false)
    await collect(await streamClaudeCode(base))
    await collect(
      await streamClaudeCode({
        ...base,
        messages: [user('hello'), assistant('Hello')],
      })
    )
    expect(vi.mocked(invoke).mock.calls[1][1]).toMatchObject({
      request: { sessionId: null, prompt: 'hello' },
    })
  })

  it('rejects files and tools instead of silently discarding them', () => {
    expect(() =>
      textTurns([
        {
          id: 'file',
          role: 'user',
          parts: [
            {
              type: 'file',
              mediaType: 'image/png',
              url: 'data:image/png;base64,AA==',
            },
          ],
        },
      ])
    ).toThrow('text conversations')
    expect(() =>
      textTurns([
        {
          id: 'tool',
          role: 'assistant',
          parts: [{ type: 'tool-test' } as never],
        },
      ])
    ).toThrow('text conversations')
  })

  it('propagates failures and clears the previous resumable binding', async () => {
    await collect(await streamClaudeCode(base))
    vi.mocked(invoke).mockRejectedValueOnce('Usage limit reached')
    await expect(
      collect(
        await streamClaudeCode({
          ...base,
          messages: [user('hello'), assistant('Hello'), user('next')],
        })
      )
    ).rejects.toThrow('Usage limit reached')
    expect(
      localStorage.getItem('atomic-claude-session:' + base.threadId)
    ).toBeNull()
  })

  it('handles abort before the backend has registered the request', async () => {
    const abort = new AbortController()
    let events: Call['events'] | undefined
    let resolve: (value: unknown) => void = () => {}
    vi.mocked(invoke).mockImplementation((command, args) => {
      if (command !== 'atomic_claude_chat')
        return Promise.resolve(undefined as never)
      events = (args as unknown as Call).events
      return new Promise((done) => {
        resolve = done
      })
    })
    const stream = await streamClaudeCode({
      ...base,
      abortSignal: abort.signal,
    })
    abort.abort()
    events!.onmessage({ type: 'ready' })
    resolve({ sessionId, text: 'Too late', inputTokens: 0, outputTokens: 0 })
    await collect(stream)
    expect(invoke).toHaveBeenCalledWith('atomic_claude_cancel', {
      requestId: expect.any(String),
    })
    expect(
      localStorage.getItem('atomic-claude-session:' + base.threadId)
    ).toBeNull()
  })

  it('does not start a process for a pre-aborted request', async () => {
    const abort = new AbortController()
    abort.abort()
    await expect(
      streamClaudeCode({ ...base, abortSignal: abort.signal })
    ).rejects.toMatchObject({ name: 'AbortError' })
    expect(invoke).not.toHaveBeenCalled()
  })
})

it('cancels browser sign-in even when stop precedes the IPC ready handshake', async () => {
  const controller = new AbortController()
  let ready: (() => void) | undefined
  let finish: (() => void) | undefined
  vi.mocked(invoke).mockImplementation((command, args) => {
    if (command !== 'atomic_claude_login')
      return Promise.resolve(undefined as never)
    const channel = (
      args as { events: { onmessage: (event: unknown) => void } }
    ).events
    ready = () => channel.onmessage({ type: 'ready' })
    return new Promise((resolve) => {
      finish = () => resolve(undefined as never)
    })
  })
  const result = loginClaudeCode(controller.signal)
  controller.abort()
  ready!()
  finish!()
  await expect(result).rejects.toMatchObject({ name: 'AbortError' })
  expect(invoke).toHaveBeenCalledWith('atomic_claude_cancel', {
    requestId: expect.any(String),
  })
})
