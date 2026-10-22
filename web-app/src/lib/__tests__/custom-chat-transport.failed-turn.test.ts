import type { UIMessage } from '@ai-sdk/react'
import type { LanguageModel } from 'ai'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useMCPServers } from '@/hooks/useMCPServers'
import { useAppState } from '@/hooks/useAppState'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { seedServiceHub } from '@/test/service-hub'
import { convertThreadMessageToUIMessage } from '@/lib/messages'
import { finishedAssistantMessage } from '@/lib/turn-error'
import { CustomChatTransport } from '../custom-chat-transport'
import { ModelFactory } from '../model-factory'

// Tauri-only loaders and readiness checks, mocked at the boundary as in the
// transport harness; the conversion pipeline under test runs for real.
vi.mock('../chat-skill-injection', async (importOriginal) => {
  const actual =
    await importOriginal<typeof import('../chat-skill-injection')>()
  return { ...actual, loadChatSkillDetails: vi.fn().mockResolvedValue([]) }
})
vi.mock('@/utils/ensureRemoteProviderReady', () => ({
  ensureRemoteProviderReady: vi.fn().mockResolvedValue(undefined),
}))

const recordingModel = (): LanguageModel =>
  ({
    specificationVersion: 'v2',
    provider: 'fixture',
    modelId: 'fixture-model',
    supportedUrls: {},
    doGenerate: vi.fn(),
    doStream: vi.fn(async () => ({
      stream: new ReadableStream({
        start(controller) {
          controller.enqueue({ type: 'stream-start', warnings: [] })
          controller.enqueue({
            type: 'finish',
            finishReason: 'stop',
            usage: { inputTokens: 1, outputTokens: 0, totalTokens: 1 },
          })
          controller.close()
        },
      }),
    })),
  }) as unknown as LanguageModel

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

describe('CustomChatTransport with a failed turn in the history', () => {
  it('does not send a failed turn that produced nothing to the model', async () => {
    // How a turn that failed on a bad API key comes back after a relaunch.
    const failedTurn = convertThreadMessageToUIMessage(
      finishedAssistantMessage({
        message: { id: 'assistant-failed', role: 'assistant', parts: [] },
        threadId: 'thread-1',
        isAbort: false,
        isError: true,
        error: new Error('401 Unauthorized'),
      })!
    )
    const messages: UIMessage[] = [
      { id: 'user-1', role: 'user', parts: [{ type: 'text', text: 'hello' }] },
      failedTurn,
      { id: 'user-2', role: 'user', parts: [{ type: 'text', text: 'again' }] },
    ]
    const model = recordingModel()
    vi.spyOn(ModelFactory, 'createModel').mockResolvedValue(model)
    const transport = new CustomChatTransport(undefined, 'thread-1')

    const stream = (await transport.sendMessages({
      chatId: 'chat-1',
      messages,
      abortSignal: undefined,
      trigger: 'submit-message',
      messageId: undefined,
    })) as ReadableStream<unknown>
    for await (const chunk of stream) void chunk

    const doStream = (
      model as unknown as { doStream: ReturnType<typeof vi.fn> }
    ).doStream
    const prompt = doStream.mock.calls[0][0].prompt as Array<{ role: string }>
    expect(prompt.filter((message) => message.role === 'assistant')).toEqual([])
    expect(JSON.stringify(prompt)).toContain('again')
  })
})
