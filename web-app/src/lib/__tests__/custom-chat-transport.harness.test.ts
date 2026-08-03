import type { UIMessage } from '@ai-sdk/react'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'

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

describe('CustomChatTransport production harness', () => {
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
