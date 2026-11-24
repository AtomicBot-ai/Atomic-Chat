import type { UIMessage } from '@ai-sdk/react'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useThreads } from '@/hooks/useThreads'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'
import {
  resetAutoCompactions,
  type ThreadCompaction,
} from '../context-compaction'
import { summaryBlock } from '../core-context-contract'

/**
 * The pre-flight of every local engine against the core's context routes:
 * an engine that reloads in seconds grows straight to its device maximum,
 * every other overflow compacts the history, the compaction is stored on the
 * thread and rebuilds every later request, and a summary that cannot be made
 * leaves out the oldest turns instead.
 */

const mocks = vi.hoisted(() => ({
  measureContext: vi.fn(),
  compactContext: vi.fn(),
  growModelContext: vi.fn(),
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
}))

vi.mock('../core-context', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core-context')>()),
  measureContext: mocks.measureContext,
  compactContext: mocks.compactContext,
}))
vi.mock('../context-size', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../context-size')>()),
  growModelContext: mocks.growModelContext,
  getModelMaxCtxTrain: vi.fn(async () => undefined),
}))
vi.mock('../chat-skill-injection', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../chat-skill-injection')>()),
  loadChatSkillDetails: vi.fn().mockResolvedValue([]),
}))
vi.mock('@/utils/ensureRemoteProviderReady', () => ({
  ensureRemoteProviderReady: vi.fn().mockResolvedValue(undefined),
}))
vi.mock('sonner', () => ({
  toast: {
    info: mocks.toastInfo,
    warning: mocks.toastWarning,
    error: vi.fn(),
    success: vi.fn(),
  },
}))

type Prompt = Array<{ role: string; content: unknown }>

/** A model that answers "ok" and keeps the prompts it was sent. */
function recordingModel(prompts: Prompt[]): LanguageModel {
  return {
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'fixture-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async (options: { prompt: Prompt }) => {
      prompts.push(options.prompt)
      return {
        stream: new ReadableStream({
          start(controller) {
            for (const part of [
              { type: 'stream-start', warnings: [] },
              { type: 'text-start', id: 't' },
              { type: 'text-delta', id: 't', delta: 'ok' },
              { type: 'text-end', id: 't' },
              {
                type: 'finish',
                finishReason: 'stop',
                usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
              },
            ]) {
              controller.enqueue(part)
            }
            controller.close()
          },
        }),
      }
    }),
  } as unknown as LanguageModel
}

const message = (id: string, role: 'user' | 'assistant', text: string) =>
  ({ id, role, parts: [{ type: 'text', text }] }) as UIMessage

const conversation: UIMessage[] = [
  message('u1', 'user', 'What makes tides?'),
  message('a1', 'assistant', 'The moon.'),
  message('u2', 'user', 'And spring tides?'),
  message('a2', 'assistant', 'Sun and moon aligned.'),
  message('u3', 'user', 'Neap tides?'),
]

const THREAD = 'thread-1'

const measure = (
  promptTokens: number,
  windowTokens: number | undefined,
  resize: 'reload' | 'restart' | 'fixed',
  maxWindowTokens?: number
) => ({
  promptTokens,
  exact: true,
  ...(windowTokens !== undefined ? { windowTokens } : {}),
  ...(maxWindowTokens !== undefined ? { maxWindowTokens } : {}),
  resize,
  supportsPromptProgress: false,
})

function selectProvider(provider: string) {
  useModelProvider.setState({
    selectedProvider: provider,
    selectedModel: {
      id: 'fixture-model',
      capabilities: [],
      settings: {},
    } as never,
    providers: [
      {
        provider,
        active: true,
        api_key: '',
        base_url: 'http://localhost',
        models: [{ id: 'fixture-model', settings: {} }],
        settings: [],
      },
    ] as never,
  })
}

function seedThread(metadata: Record<string, unknown> = {}) {
  useThreads.setState({
    threads: {
      [THREAD]: { id: THREAD, title: 'Tides', updated: 0, metadata },
    } as never,
  })
}

async function send(
  transport: CustomChatTransport,
  messages: UIMessage[] = conversation
) {
  const stream = await transport.sendMessages({
    chatId: THREAD,
    messages,
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: undefined,
  })
  const chunks: unknown[] = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

/** The text of the user and assistant turns a prompt sends, in order. */
const turns = (prompt: Prompt) =>
  prompt
    .filter((m) => m.role !== 'system')
    .map((m) =>
      (m.content as Array<{ type: string; text?: string }>)
        .map((part) => part.text ?? '')
        .join('')
    )

const systemOf = (prompt: Prompt) =>
  prompt.find((m) => m.role === 'system')?.content as string | undefined

const compaction = (summary = 'Tides come from the moon.') => ({
  ok: true as const,
  result: {
    summary,
    // [system, u1, a1, u2, a2, u3]: keep from u3.
    keepFrom: 5,
    summarizedCount: 4,
    tokensBefore: 9000,
    tokensAfter: 2000,
    cached: false,
  },
})

describe('CustomChatTransport history compaction', () => {
  let prompts: Prompt[]

  beforeEach(() => {
    vi.clearAllMocks()
    resetAutoCompactions()
    prompts = []
    useMCPServers.setState({ mcpServers: {} })
    seedServiceHub({
      rag: { getTools: vi.fn().mockResolvedValue([]) } as never,
      threads: { updateThread: vi.fn().mockResolvedValue(undefined) } as never,
    })
    useAppState.setState({
      tools: [],
      ragToolNames: new Set(),
      mcpToolNames: new Set(),
      contextActivity: { phase: null },
    })
    useToolAvailable.setState({ disabledTools: {}, defaultDisabledTools: [] })
    seedThread()
    vi.spyOn(ModelFactory, 'createModel').mockImplementation(async () =>
      recordingModel(prompts)
    )
  })

  it('grows a llama.cpp window below its maximum straight to it, once', async () => {
    selectProvider('llamacpp-upstream')
    mocks.measureContext.mockResolvedValue(measure(9000, 8192, 'reload', 32768))
    mocks.growModelContext.mockResolvedValue({
      ok: true,
      from: 8192,
      to: 32768,
    })

    await send(new CustomChatTransport('Be brief.', THREAD))

    expect(mocks.growModelContext).toHaveBeenCalledTimes(1)
    expect(mocks.growModelContext).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'llamacpp-upstream',
        minCtxLen: 32768,
        capCtxLen: 32768,
      })
    )
    // Once before the pre-flight, once against the reloaded session.
    expect(ModelFactory.createModel).toHaveBeenCalledTimes(2)
    expect(mocks.compactContext).not.toHaveBeenCalled()
    expect(turns(prompts[0])).toHaveLength(5)
  })

  it.each([
    ['vllm', 'restart'],
    ['foundry-local', 'fixed'],
  ] as const)(
    'compacts a %s (%s) history, stores it and sends the summary with the kept turns',
    async (provider, resize) => {
      selectProvider(provider)
      mocks.measureContext
        .mockResolvedValueOnce(measure(9000, 8192, resize))
        .mockResolvedValueOnce(measure(2000, 8192, resize))
      mocks.compactContext.mockResolvedValue(compaction())

      await send(new CustomChatTransport('Be brief.', THREAD))

      expect(mocks.growModelContext).not.toHaveBeenCalled()
      expect(mocks.compactContext).toHaveBeenCalledTimes(1)
      const [, , request] = mocks.compactContext.mock.calls[0]
      // The summary request carries the system prompt and every turn.
      expect(request.messages.map((m: { role: string }) => m.role)).toEqual([
        'system',
        'user',
        'assistant',
        'user',
        'assistant',
        'user',
      ])
      expect(request.messages[0].content).toBe('Be brief.')
      expect(request.reserveTokens).toBe(1024)

      const stored = useThreads.getState().threads[THREAD].metadata
        ?.compaction as ThreadCompaction
      expect(stored).toMatchObject({
        summary: 'Tides come from the moon.',
        upToMessageId: 'u3',
        summarizedCount: 4,
        tokensBefore: 9000,
        tokensAfter: 2000,
        modelId: 'fixture-model',
        provider,
      })

      // Measured once more after the compaction, then sent.
      expect(mocks.measureContext).toHaveBeenCalledTimes(2)
      expect(turns(prompts[0])).toEqual(['Neap tides?'])
      expect(systemOf(prompts[0])).toBe(
        `Be brief.\n\n${summaryBlock('Tides come from the moon.')}`
      )
      // "Compacting chat history…" ends at the answer's first token.
      expect(useAppState.getState().contextActivity.phase).toBeNull()
    }
  )

  it('sends the whole history when the window is unknown', async () => {
    selectProvider('vllm')
    mocks.measureContext.mockResolvedValue(measure(50000, undefined, 'restart'))

    await send(new CustomChatTransport('Be brief.', THREAD))

    expect(mocks.compactContext).not.toHaveBeenCalled()
    expect(mocks.growModelContext).not.toHaveBeenCalled()
    expect(turns(prompts[0])).toHaveLength(5)
  })

  it('rebuilds every later request from the stored compaction, after a relaunch too', async () => {
    selectProvider('vllm')
    seedThread({
      compaction: {
        summary: 'Tides come from the moon.',
        upToMessageId: 'u3',
        summarizedCount: 4,
        tokensBefore: 9000,
        tokensAfter: 2000,
        modelId: 'fixture-model',
        provider: 'vllm',
        createdAt: 1,
      },
    })
    mocks.measureContext.mockResolvedValue(measure(2000, 8192, 'restart'))

    // A fresh transport: what a relaunch or a switch of threads gets.
    await send(new CustomChatTransport('Be brief.', THREAD), [
      ...conversation,
      message('a3', 'assistant', 'Sun and moon at right angles.'),
      message('u4', 'user', 'Thanks!'),
    ])

    expect(mocks.compactContext).not.toHaveBeenCalled()
    expect(turns(prompts[0])).toEqual([
      'Neap tides?',
      'Sun and moon at right angles.',
      'Thanks!',
    ])
    expect(systemOf(prompts[0])).toContain('<conversation_summary>')
  })

  it('leaves a compaction behind once its boundary is gone, and for a cloud model', async () => {
    const stored = {
      summary: 'Tides come from the moon.',
      upToMessageId: 'u3',
      summarizedCount: 4,
      tokensBefore: 9000,
      tokensAfter: 2000,
      modelId: 'fixture-model',
      provider: 'vllm',
      createdAt: 1,
    }
    seedThread({ compaction: stored })
    selectProvider('openai')
    mocks.measureContext.mockResolvedValue(undefined)

    await send(new CustomChatTransport('Be brief.', THREAD))
    expect(turns(prompts[0])).toHaveLength(5)
    expect(systemOf(prompts[0])).toBe('Be brief.')

    selectProvider('vllm')
    await send(
      new CustomChatTransport('Be brief.', THREAD),
      conversation.slice(0, 4).concat(message('u3b', 'user', 'Edited.'))
    )
    expect(turns(prompts[1])).toHaveLength(5)
    expect(systemOf(prompts[1])).toBe('Be brief.')
  })

  it('leaves out the oldest turns when the summary cannot be made, and says so', async () => {
    selectProvider('vllm')
    mocks.measureContext
      .mockResolvedValueOnce(measure(9000, 8192, 'restart'))
      .mockResolvedValueOnce(measure(5000, 8192, 'restart'))
    mocks.compactContext.mockResolvedValue({ ok: false, reason: 'failed' })
    const transport = new CustomChatTransport('Be brief.', THREAD)

    await send(transport)

    expect(useThreads.getState().threads[THREAD].metadata?.compaction).toBe(
      undefined
    )
    expect(transport.getHistoryStart()).toBe('u2')
    expect(turns(prompts[0])).toEqual([
      'And spring tides?',
      'Sun and moon aligned.',
      'Neap tides?',
    ])
    expect(mocks.toastWarning).toHaveBeenCalledWith(
      'The earlier messages could not be summarized, so 2 older messages were left out instead.',
      expect.anything()
    )
  })

  it('compacts a turn once: its retry leaves out turns instead', async () => {
    selectProvider('vllm')
    mocks.measureContext.mockImplementation(async (_p, _m, request) =>
      measure(request.messages.length >= 5 ? 9000 : 5000, 8192, 'restart')
    )
    mocks.compactContext.mockResolvedValue({ ok: false, reason: 'failed' })

    await send(new CustomChatTransport('Be brief.', THREAD))
    // A retry of the same turn on a fresh transport (no shortened start).
    await send(new CustomChatTransport('Be brief.', THREAD))

    expect(mocks.compactContext).toHaveBeenCalledTimes(1)
    expect(turns(prompts[1])).toEqual([
      'And spring tides?',
      'Sun and moon aligned.',
      'Neap tides?',
    ])
    expect(mocks.toastInfo).toHaveBeenCalledWith(
      'Left out 2 older messages so the conversation fits the context.',
      expect.anything()
    )
  })

  it('refuses only a request that does not fit without its older history', async () => {
    selectProvider('vllm')
    mocks.measureContext.mockResolvedValue(measure(9000, 8192, 'restart'))

    await expect(
      send(new CustomChatTransport('Be brief.', THREAD), [conversation[0]])
    ).rejects.toThrow(/exceeds the available context size/)
    expect(mocks.compactContext).not.toHaveBeenCalled()
    expect(useAppState.getState().contextActivity.phase).toBeNull()
  })

  it('falls back to the window growth it always had with an older core', async () => {
    selectProvider('llamacpp-upstream')
    useModelProvider.setState((state) => ({
      selectedModel: {
        ...state.selectedModel!,
        settings: { ctx_len: { controller_props: { value: 512 } } },
      } as never,
    }))
    mocks.measureContext.mockResolvedValue(undefined)
    mocks.growModelContext.mockResolvedValue({ ok: true, from: 512, to: 8192 })

    const transport = new CustomChatTransport('Be brief.', THREAD)
    await send(transport, [conversation[0]])

    expect(mocks.growModelContext).toHaveBeenCalledWith(
      expect.objectContaining({ minCtxLen: expect.any(Number) })
    )
    expect(mocks.growModelContext.mock.calls[0][0].capCtxLen).toBeUndefined()
    expect(mocks.compactContext).not.toHaveBeenCalled()
    expect(transport.lastContextMeasure).toBeUndefined()
  })

  it('compacts on request and stores it for the next send', async () => {
    selectProvider('mlx')
    // No system prompt: [u1, a1, u2, a2, u3]; keep from u2.
    mocks.compactContext.mockResolvedValue({
      ok: true,
      result: { ...compaction('Moon and sun.').result, keepFrom: 2 },
    })
    const transport = new CustomChatTransport(undefined, THREAD)

    const outcome = await transport.compactHistory({ messages: conversation })

    expect(outcome).toMatchObject({
      ok: true,
      compaction: {
        upToMessageId: 'u2',
        summary: 'Moon and sun.',
        summarizedCount: 2,
      },
    })
    expect(
      useThreads.getState().threads[THREAD].metadata?.compaction
    ).toMatchObject({ upToMessageId: 'u2' })
    expect(ModelFactory.createModel).not.toHaveBeenCalled()
    // The thread's own messages are left as they were.
    expect(conversation[0].parts).toEqual([
      { type: 'text', text: 'What makes tides?' },
    ])

    mocks.measureContext.mockResolvedValue(measure(2000, 8192, 'reload'))
    await send(transport)
    expect(turns(prompts[0])).toEqual([
      'And spring tides?',
      'Sun and moon aligned.',
      'Neap tides?',
    ])
    expect(systemOf(prompts[0])).toBe(summaryBlock('Moon and sun.'))
  })

  it('has nothing to compact in a single turn', async () => {
    selectProvider('mlx')
    const transport = new CustomChatTransport(undefined, THREAD)

    await expect(
      transport.compactHistory({ messages: [conversation[0]] })
    ).resolves.toEqual({ ok: false, reason: 'nothing' })
    expect(mocks.compactContext).not.toHaveBeenCalled()
  })
})
