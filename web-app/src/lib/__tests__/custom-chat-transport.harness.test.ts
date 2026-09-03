import type { UIMessage } from '@ai-sdk/react'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import { CustomChatTransport } from '../custom-chat-transport'
import { loadChatSkillDetails } from '../chat-skill-injection'
import { ModelFactory } from '../model-factory'

// The skill-body loader is Tauri-only (IS_TAURI is false under vitest), so it
// is mocked at the boundary; the pure collect/render/compose helpers run real.
const contextMocks = vi.hoisted(() => ({
  growModelContext: vi.fn(),
}))
vi.mock('../context-size', async (importOriginal) => {
  const actual = await importOriginal<typeof import('../context-size')>()
  return { ...actual, growModelContext: contextMocks.growModelContext }
})

vi.mock('../chat-skill-injection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../chat-skill-injection')>()
  return { ...actual, loadChatSkillDetails: vi.fn().mockResolvedValue([]) }
})

type ModelStreamPart =
  | { type: 'stream-start'; warnings: [] }
  | { type: 'text-start'; id: string }
  | { type: 'text-delta'; id: string; delta: string }
  | { type: 'text-end'; id: string }
  | { type: 'tool-input-start'; id: string; toolName: string }
  | { type: 'tool-input-delta'; id: string; delta: string }
  | { type: 'tool-input-end'; id: string }
  | {
      type: 'tool-call'
      toolCallId: string
      toolName: string
      input: string
    }
  | {
      type: 'finish'
      finishReason: 'stop' | 'tool-calls'
      usage: {
        inputTokens: number
        outputTokens: number
        totalTokens: number
      }
    }

const fakeStreamingModel = (parts: ModelStreamPart[]): LanguageModel =>
  ({
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'fixture-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          parts.forEach((part) => controller.enqueue(part))
          controller.close()
        },
      }),
    })),
  }) as unknown as LanguageModel

const userMessage: UIMessage = {
  id: 'user-1',
  role: 'user',
  parts: [{ type: 'text', text: 'hello' }],
}

async function readChunks(
  stream: ReadableStream<Record<string, unknown>>
): Promise<Array<Record<string, unknown>>> {
  const chunks: Array<Record<string, unknown>> = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

// Shared by every describe below: a seeded service hub plus a default MLX
// provider/model, so each test only has to state what it changes.
beforeEach(() => {
  seedServiceHub({
    rag: { getTools: vi.fn().mockResolvedValue([]) } as never,
  })
  useAppState.setState({
    tools: [],
    ragToolNames: new Set(),
    mcpToolNames: new Set(),
  })
  useToolAvailable.setState({
    disabledTools: {},
    defaultDisabledTools: [],
  })
  useModelProvider.setState({
    selectedProvider: 'mlx',
    selectedModel: {
      id: 'fixture-model',
      capabilities: [],
      settings: {},
    } as never,
    providers: [
      {
        provider: 'mlx',
        active: true,
        api_key: '',
        base_url: 'http://localhost',
        models: [],
        settings: [],
      },
    ] as never,
  })
})

describe('CustomChatTransport production harness', () => {
  it('preserves delta order while stripping leaked MLX special tokens', async () => {
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'Hello ' },
        { type: 'text-delta', id: 'text-1', delta: '<|eot_id|>' },
        { type: 'text-delta', id: 'text-1', delta: 'world' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 3, totalTokens: 4 },
        },
      ])
    )
    const transport = new CustomChatTransport()

    const chunks = await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.delta)
    ).toEqual(['Hello ', ' ', 'world'])
  })

  it('repairs malformed streamed tool input through the production boundary', async () => {
    useAppState.setState({
      tools: [
        {
          name: 'search',
          server: 'fixture',
          description: 'Search',
          inputSchema: {
            type: 'object',
            properties: { query: { type: 'string' } },
            required: ['query'],
          },
        },
      ],
      mcpToolNames: new Set(['search']),
    })
    useModelProvider.setState((state) => ({
      selectedModel: {
        ...state.selectedModel!,
        capabilities: ['tools'],
      },
    }))
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel([
        { type: 'stream-start', warnings: [] },
        {
          type: 'tool-call',
          toolCallId: 'call-1',
          toolName: 'search',
          input: '{"query":"alpha"',
        },
        {
          type: 'finish',
          finishReason: 'tool-calls',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    )
    const transport = new CustomChatTransport()

    const chunks = await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    expect(chunks).toContainEqual(
      expect.objectContaining({
        type: 'tool-input-available',
        toolCallId: 'call-1',
        toolName: 'search',
        input: { query: 'alpha' },
      })
    )
  })
})

/**
 * Skills on the chat pipeline ride the system prompt: `sendMessages` reads
 * `agent_skill_name` off user-message metadata, loads bodies, and appends the
 * rendered block to the system message. Driven through the real transport so
 * the wiring into `streamText` is what gets pinned.
 */
describe('CustomChatTransport skill injection', () => {
  const idleStream: ModelStreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'ok' },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]

  it('appends invoked-skill bodies to the system prompt', async () => {
    vi.mocked(loadChatSkillDetails).mockResolvedValueOnce([
      {
        name: 'style-guide',
        version: '1.0.0',
        body: 'Always answer in haiku.',
      } as never,
    ])
    const model = fakeStreamingModel(idleStream)
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(model)
    const transport = new CustomChatTransport('be brief', 'thread-7')

    await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [
          {
            ...userMessage,
            metadata: { agent_skill_name: 'style-guide' },
          } as UIMessage,
        ],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    expect(loadChatSkillDetails).toHaveBeenCalledWith(
      ['style-guide'],
      expect.any(Map),
      expect.any(Set)
    )
    const doStream = (
      model as unknown as { doStream: ReturnType<typeof vi.fn> }
    ).doStream
    const prompt = doStream.mock.calls[0][0].prompt as Array<{
      role: string
      content: unknown
    }>
    const system = prompt.find((message) => message.role === 'system')
    expect(system?.content).toContain('be brief')
    expect(system?.content).toContain('## Invoked skills')
    expect(system?.content).toContain('# skill: style-guide (v1.0.0)')
    expect(system?.content).toContain('Always answer in haiku.')
  })

  it('sends the base system prompt untouched when no skill was invoked', async () => {
    const model = fakeStreamingModel(idleStream)
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(model)
    const transport = new CustomChatTransport('be brief', 'thread-7')

    await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    const doStream = (
      model as unknown as { doStream: ReturnType<typeof vi.fn> }
    ).doStream
    const prompt = doStream.mock.calls[0][0].prompt as Array<{
      role: string
      content: unknown
    }>
    const system = prompt.find((message) => message.role === 'system')
    expect(system?.content).toBe('be brief')
  })
})

/**
 * The reasoning override is assembled in `sendMessages` and handed to
 * `ModelFactory.createModel` as its fourth argument. These drive the real
 * transport and read that argument back, so the per-provider knob mapping is
 * pinned at the boundary where a mistake would reach a model server.
 */
describe('CustomChatTransport reasoning override', () => {
  const idleStream: ModelStreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'ok' },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]

  async function captureReasoningOverride(options: {
    provider: string
    reasoning?: Record<string, unknown>
    disableReasoning: boolean
    reasoningBudget: string
  }): Promise<Record<string, unknown> | undefined> {
    useGeneralSetting.setState({
      disableReasoning: options.disableReasoning,
      reasoningBudget: options.reasoningBudget,
    } as never)
    useModelProvider.setState({
      selectedProvider: options.provider,
      selectedModel: {
        id: 'fixture-model',
        capabilities: [],
        settings: {},
        reasoning: options.reasoning,
      } as never,
      providers: [
        {
          provider: options.provider,
          active: true,
          api_key: '',
          base_url: 'http://localhost',
          models: [],
          settings: [],
        },
      ] as never,
    })

    const createModel = vi
      .spyOn(ModelFactory, 'createModel')
      .mockResolvedValue(fakeStreamingModel(idleStream))

    await readChunks(
      (await new CustomChatTransport().sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    return createModel.mock.calls[0]?.[3] as Record<string, unknown> | undefined
  }

  it('sends a top-level reasoning_effort to mlx when the template declares an off value', async () => {
    const override = await captureReasoningOverride({
      provider: 'mlx',
      reasoning: { supportsThinking: true, offValue: 'none' },
      disableReasoning: true,
      reasoningBudget: 'medium',
    })

    expect(override?.chat_template_kwargs).toEqual({
      enable_thinking: false,
      reasoning_effort: 'none',
    })
    // mlx-vlm only forwards the top-level field to the template.
    expect(override?.reasoning_effort).toBe('none')
  })

  it('keeps the off value inside chat_template_kwargs for llama.cpp', async () => {
    const override = await captureReasoningOverride({
      provider: 'llamacpp',
      reasoning: { supportsThinking: true, offValue: 'none' },
      disableReasoning: true,
      reasoningBudget: 'medium',
    })

    expect(override?.chat_template_kwargs).toEqual({
      enable_thinking: false,
      reasoning_effort: 'none',
    })
    // llama.cpp ignores the OpenAI-style top-level field.
    expect(override?.reasoning_effort).toBeUndefined()
  })

  it('omits reasoning_effort when the template declares no off value', async () => {
    const override = await captureReasoningOverride({
      provider: 'llamacpp-upstream',
      reasoning: { supportsThinking: true },
      disableReasoning: false,
      reasoningBudget: 'off',
    })

    expect(override?.chat_template_kwargs).toEqual({ enable_thinking: false })
    expect(override?.reasoning_effort).toBeUndefined()
  })

  it('maps an active budget level onto the backend token sampler', async () => {
    const override = await captureReasoningOverride({
      provider: 'llamacpp',
      reasoning: { supportsThinking: true },
      disableReasoning: false,
      reasoningBudget: 'high',
    })

    expect(override?.reasoning_budget_tokens).toBe(4096)
  })

  it('maps an active budget level onto a declared native effort value', async () => {
    const override = await captureReasoningOverride({
      provider: 'mlx',
      reasoning: {
        supportsThinking: true,
        effortKwarg: 'reasoning_effort',
        effortValues: ['low', 'high'],
      },
      disableReasoning: false,
      reasoningBudget: 'high',
    })

    expect(override?.reasoning_effort).toBe('high')
  })

  it('passes no override at all when the model has no thinking phase', async () => {
    const override = await captureReasoningOverride({
      provider: 'llamacpp',
      reasoning: undefined,
      disableReasoning: false,
      reasoningBudget: 'medium',
    })

    expect(override).toBeUndefined()
  })
})

/**
 * Small mutators the chat route drives between turns. They are plain state
 * setters, but a regression here silently changes what the next request sends.
 */
describe('CustomChatTransport per-turn state', () => {
  it('reports the thread it is bound to', () => {
    expect(new CustomChatTransport(undefined, 'thread-7').getThreadId()).toBe(
      'thread-7'
    )
    expect(new CustomChatTransport().getThreadId()).toBeUndefined()
  })

  it('starts with no tools until availability is resolved', async () => {
    const transport = new CustomChatTransport()
    expect(transport.getTools()).toEqual({})

    await transport.updateRagToolsAvailability(false, false, false)
    expect(transport.getTools()).toEqual({})
  })

  it('prefills the next request with the content to continue from', async () => {
    useGeneralSetting.setState({
      disableReasoning: false,
      reasoningBudget: 'medium',
    } as never)
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: ' and then some' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
        },
      ])
    )
    const transport = new CustomChatTransport()
    transport.setContinueFromContent('A partial answer')

    const chunks = await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    // The prefill is replayed into the stream so the UI keeps the full answer.
    expect(
      chunks
        .filter((chunk) => chunk.type === 'text-delta')
        .map((chunk) => chunk.delta)
        .join('')
    ).toContain('A partial answer')
  })

  it('reports token usage to the registered callback', async () => {
    useGeneralSetting.setState({
      disableReasoning: false,
      reasoningBudget: 'medium',
    } as never)
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel([
        { type: 'stream-start', warnings: [] },
        { type: 'text-start', id: 'text-1' },
        { type: 'text-delta', id: 'text-1', delta: 'ok' },
        { type: 'text-end', id: 'text-1' },
        {
          type: 'finish',
          finishReason: 'stop',
          usage: { inputTokens: 11, outputTokens: 7, totalTokens: 18 },
        },
      ])
    )
    const transport = new CustomChatTransport()
    const onTokenUsage = vi.fn()
    transport.setOnTokenUsage(onTokenUsage)
    transport.updateSystemMessage('be brief')

    await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

    expect(onTokenUsage).toHaveBeenCalledOnce()
    expect(onTokenUsage.mock.calls[0][0]).toEqual(
      expect.objectContaining({ inputTokens: 11, outputTokens: 7 })
    )
  })
})

/**
 * Pre-flight context sizing: before `streamText`, local providers estimate
 * the prompt and grow the context window once when it would not fit —
 * instead of sending, failing with "exceeds the available context size",
 * reloading and regenerating.
 */
describe('CustomChatTransport pre-flight context sizing', () => {
  const idleStream: ModelStreamPart[] = [
    { type: 'stream-start', warnings: [] },
    { type: 'text-start', id: 'text-1' },
    { type: 'text-delta', id: 'text-1', delta: 'ok' },
    { type: 'text-end', id: 'text-1' },
    {
      type: 'finish',
      finishReason: 'stop',
      usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
    },
  ]

  const send = async (transport: CustomChatTransport) =>
    readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )

  const selectCtx = (ctxLen: number, autoIncrease = true) =>
    useModelProvider.setState((state) => ({
      selectedModel: {
        ...state.selectedModel!,
        settings: {
          ctx_len: { controller_props: { value: ctxLen } },
          auto_increase_ctx_len: { controller_props: { value: autoIncrease } },
        },
      },
    }))

  beforeEach(() => {
    contextMocks.growModelContext.mockReset()
  })

  it('grows the window once and re-creates the model when the prompt would not fit', async () => {
    // 'hello' + the 1024-token output reserve cannot fit a 512-token window.
    selectCtx(512)
    contextMocks.growModelContext.mockResolvedValue({
      ok: true,
      from: 512,
      to: 8192,
    })
    const createModel = vi
      .spyOn(ModelFactory, 'createModel')
      .mockResolvedValue(fakeStreamingModel(idleStream))
    const transport = new CustomChatTransport()

    const chunks = await send(transport)

    expect(contextMocks.growModelContext).toHaveBeenCalledTimes(1)
    expect(contextMocks.growModelContext).toHaveBeenCalledWith(
      expect.objectContaining({
        providerId: 'mlx',
        modelId: 'fixture-model',
        minCtxLen: expect.any(Number),
      })
    )
    const { minCtxLen } = contextMocks.growModelContext.mock.calls[0][0]
    expect(minCtxLen).toBeGreaterThan(1024)
    // Once before the pre-flight, once against the reloaded session.
    expect(createModel).toHaveBeenCalledTimes(2)
    expect(chunks.some((chunk) => chunk.type === 'text-delta')).toBe(true)
    expect(transport.lastPromptSize).toEqual(
      expect.objectContaining({ ctxLen: 8192, measured: false })
    )
  })

  it('does nothing when the prompt fits', async () => {
    selectCtx(65536)
    const createModel = vi
      .spyOn(ModelFactory, 'createModel')
      .mockResolvedValue(fakeStreamingModel(idleStream))

    await send(new CustomChatTransport())

    expect(contextMocks.growModelContext).not.toHaveBeenCalled()
    expect(createModel).toHaveBeenCalledTimes(1)
  })

  it('respects a disabled auto_increase_ctx_len', async () => {
    selectCtx(512, false)
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel(idleStream)
    )

    await send(new CustomChatTransport())

    expect(contextMocks.growModelContext).not.toHaveBeenCalled()
  })

  it('refuses to send into a window that is already at the model maximum', async () => {
    selectCtx(512)
    contextMocks.growModelContext.mockResolvedValue({
      ok: false,
      reason: 'at_max',
      from: 512,
      max: 512,
    })
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      fakeStreamingModel(idleStream)
    )

    await expect(send(new CustomChatTransport())).rejects.toThrow(
      /exceeds the available context size/
    )
  })
})

/**
 * Per-chat muted connectors and the tool-cost report: muting a server drops
 * its tools from the request (the server keeps running), and every refresh
 * records what the remaining definitions cost against the model's window.
 */
describe('CustomChatTransport muted connectors and tool cost', () => {
  const linearTools = Array.from({ length: 5 }, (_, i) => ({
    name: `linear_tool_${i}`,
    server: 'linear',
    description: 'A Linear tool with a fairly long description. '.repeat(6),
    inputSchema: {
      type: 'object',
      properties: { id: { type: 'string', description: 'Issue id' } },
    },
  }))
  const exaTool = {
    name: 'web_search_exa',
    server: 'exa',
    description: 'Search the web',
    inputSchema: { type: 'object', properties: { query: { type: 'string' } } },
  }

  beforeEach(() => {
    useAppState.setState({
      tools: [...linearTools, exaTool],
      mcpToolNames: new Set([...linearTools.map((t) => t.name), exaTool.name]),
      toolCostReports: {},
    })
    useToolAvailable.setState({ mutedServers: {}, defaultMutedServers: [] })
    useModelProvider.setState((state) => ({
      selectedModel: {
        ...state.selectedModel!,
        capabilities: ['tools'],
        settings: { ctx_len: { controller_props: { value: 2048 } } },
      },
    }))
  })

  const sendAndCaptureTools = async () => {
    const doStream = vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          })
          controller.close()
        },
      }),
    }))
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue({
      specificationVersion: 'v2',
      provider: 'fixture',
      modelId: 'fixture-model',
      supportedUrls: {},
      doGenerate: vi.fn(),
      doStream,
    } as unknown as LanguageModel)
    const transport = new CustomChatTransport()
    await readChunks(
      (await transport.sendMessages({
        chatId: 'chat-1',
        messages: [userMessage],
        abortSignal: undefined,
        trigger: 'submit-message',
        messageId: undefined,
      })) as ReadableStream<Record<string, unknown>>
    )
    const call = doStream.mock.calls[0]?.[0] as
      | { tools?: Array<{ name: string }> }
      | undefined
    return (call?.tools ?? []).map((t) => t.name).sort()
  }

  it('sends every connector by default and reports the per-server cost', async () => {
    const sent = await sendAndCaptureTools()

    expect(sent).toEqual(
      [...linearTools.map((t) => t.name), exaTool.name].sort()
    )
    const report = useAppState.getState().toolCostReports['']
    expect(report.toolCount).toBe(6)
    expect(report.perServer.map((s) => s.server)).toEqual(['linear', 'exa'])
    expect(report.ctxLen).toBe(2048)
    // 5 verbose tools on a 2k window: Linear is heavy, the total is too.
    expect(report.heavyServers).toEqual(['linear'])
    expect(report.tooHeavy).toBe(true)
  })

  it('drops a muted connector from the request but keeps the others', async () => {
    useToolAvailable.setState({ defaultMutedServers: ['linear'] })

    const sent = await sendAndCaptureTools()

    expect(sent).toEqual([exaTool.name])
    const report = useAppState.getState().toolCostReports['']
    expect(report.perServer.map((s) => s.server)).toEqual(['exa'])
    expect(report.tooHeavy).toBe(false)
  })

  it('never sends a system server (filesystem, fetch) — that is agent-mode tooling', async () => {
    const systemTools = [
      { ...exaTool, name: 'read_file', server: 'filesystem' },
      { ...exaTool, name: 'fetch', server: 'fetch' },
    ]
    useAppState.setState({
      tools: [...linearTools, exaTool, ...systemTools],
      mcpToolNames: new Set([
        ...linearTools.map((t) => t.name),
        exaTool.name,
        ...systemTools.map((t) => t.name),
      ]),
    })

    const sent = await sendAndCaptureTools()

    expect(sent).toEqual(
      [...linearTools.map((t) => t.name), exaTool.name].sort()
    )
    const report = useAppState.getState().toolCostReports['']
    expect(report.perServer.map((s) => s.server)).toEqual(['linear', 'exa'])
  })
})
