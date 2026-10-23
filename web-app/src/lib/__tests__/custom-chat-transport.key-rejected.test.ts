import type { UIMessage } from '@ai-sdk/react'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMCPServers } from '@/hooks/useMCPServers'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import {
  keyStatusFor,
  useProviderKeyStatusStore,
} from '@/stores/provider-key-status-store'
import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'

// Tauri-only loaders and readiness checks, mocked at the boundary as in the
// transport harness; the request and its error handling run for real.
vi.mock('../chat-skill-injection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../chat-skill-injection')>()
  return { ...actual, loadChatSkillDetails: vi.fn().mockResolvedValue([]) }
})
vi.mock('@/utils/ensureRemoteProviderReady', () => ({
  ensureRemoteProviderReady: vi.fn().mockResolvedValue(undefined),
}))

/** A provider that turns the request down, the way a cloud API does a bad key. */
const refusingModel = (error: Error): LanguageModel =>
  ({
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'gpt-5.4',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => {
      throw error
    }),
  }) as unknown as LanguageModel

/** A provider that answers the turn in full. */
const answeringModel = (): LanguageModel =>
  ({
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'gpt-5.4',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({ type: 'text-start', id: 't' })
          controller.enqueue({ type: 'text-delta', id: 't', delta: 'Hi' })
          controller.enqueue({ type: 'text-end', id: 't' })
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 1, totalTokens: 2 },
          })
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

async function send(): Promise<Array<Record<string, unknown>>> {
  const stream = (await new CustomChatTransport().sendMessages({
    chatId: 'chat-1',
    messages: [userMessage],
    abortSignal: undefined,
    trigger: 'submit-message',
    messageId: undefined,
  })) as ReadableStream<Record<string, unknown>>
  const chunks: Array<Record<string, unknown>> = []
  for await (const chunk of stream) chunks.push(chunk)
  return chunks
}

const openaiStatus = () =>
  keyStatusFor(
    { provider: 'openai', api_key: 'invalid-qa-test-key' },
    useProviderKeyStatusStore.getState().statuses
  )

beforeEach(() => {
  useMCPServers.setState({ mcpServers: {} })
  seedServiceHub({
    rag: { getTools: vi.fn().mockResolvedValue([]) } as never,
  })
  useAppState.setState({
    tools: [],
    ragToolNames: new Set(),
    mcpToolNames: new Set(),
  })
  useToolAvailable.setState({ disabledTools: {}, defaultDisabledTools: [] })
  useProviderKeyStatusStore.setState({ statuses: {} })
  useModelProvider.setState({
    selectedProvider: 'openai',
    selectedModel: {
      id: 'gpt-5.4',
      capabilities: [],
      settings: {},
    } as never,
    providers: [
      {
        provider: 'openai',
        active: true,
        api_key: 'invalid-qa-test-key',
        base_url: 'https://api.openai.com/v1',
        models: [{ id: 'gpt-5.4' }],
        settings: [],
      },
    ] as never,
  })
})

describe('CustomChatTransport and a refused key', () => {
  it('stops reading the provider as connected once it refuses the key', async () => {
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      refusingModel(
        Object.assign(
          new Error('Incorrect API key provided: invalid-*******-key.'),
          { statusCode: 401 }
        )
      )
    )

    const chunks = await send()

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(true)
    expect(openaiStatus()).toMatchObject({
      state: 'rejected',
      message: 'Incorrect API key provided: invalid-*******-key.',
    })
  })

  it.each([
    ['a dropped connection', new Error('socket hang up')],
    [
      "the Local API Server's own 401",
      Object.assign(new Error('Unauthorized'), {
        statusCode: 401,
        responseBody: 'Invalid or missing authorization token',
      }),
    ],
    [
      'a 403 from the provider',
      Object.assign(new Error('Forbidden'), {
        statusCode: 403,
        responseBody:
          '{"error":{"message":"Your request was flagged by moderation"}}',
      }),
    ],
  ])('leaves the key alone after %s', async (_, error) => {
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      refusingModel(error)
    )

    await send()

    expect(openaiStatus()).toBeUndefined()
  })

  it('reads the key as working again once the provider answers a turn', async () => {
    useProviderKeyStatusStore
      .getState()
      .setStatus('openai', 'invalid-qa-test-key', 'rejected', 'earlier 401')
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(answeringModel())

    const chunks = await send()

    expect(chunks.some((chunk) => chunk.type === 'error')).toBe(false)
    expect(openaiStatus()).toBeUndefined()
  })

  it('keeps the verdict when the turn failed', async () => {
    useProviderKeyStatusStore
      .getState()
      .setStatus('openai', 'invalid-qa-test-key', 'rejected', 'earlier 401')
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(
      refusingModel(new Error('socket hang up'))
    )

    await send()

    expect(openaiStatus()?.state).toBe('rejected')
  })
})
