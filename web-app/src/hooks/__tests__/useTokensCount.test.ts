import { renderHook, waitFor } from '@testing-library/react'
import type { ThreadMessage } from '@janhq/core'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useTokensCount } from '../useTokensCount'
import { useModelProvider } from '../useModelProvider'
import { useThreads } from '../useThreads'
import { seedServiceHub } from '@/test/service-hub'
import { summaryBlock } from '@/lib/core-context-contract'

/**
 * The context meter counts every local engine: llama.cpp through its own
 * tokenizer as before, every other one through the core's `context/measure`,
 * whose window becomes the meter's capacity. After a compaction it counts
 * what a request sends: the summary and the kept messages.
 */

const { measureContext } = vi.hoisted(() => ({ measureContext: vi.fn() }))
vi.mock('@/lib/core-context', async (load) => ({
  ...(await load<typeof import('@/lib/core-context')>()),
  measureContext,
}))

const THREAD = 'thread-1'

const message = (id: string, role: 'user' | 'assistant', value: string) =>
  ({
    id,
    role,
    thread_id: THREAD,
    created_at: 0,
    content: [{ type: 'text', text: { value, annotations: [] } }],
  }) as unknown as ThreadMessage

const history = [
  message('u1', 'user', 'What makes tides?'),
  message('a1', 'assistant', 'The moon.'),
  message('u2', 'user', 'Neap tides?'),
]

const getTokensCount = vi.fn()

function select(provider: string) {
  useModelProvider.setState({
    selectedProvider: provider,
    selectedModel: {
      id: 'fixture-model',
      settings: { ctx_len: { controller_props: { value: 4096 } } },
    } as never,
  })
}

describe('useTokensCount', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub({ models: { getTokensCount } as never })
    useThreads.setState({
      currentThreadId: THREAD,
      threads: {
        [THREAD]: { id: THREAD, title: 'Tides', updated: 0, metadata: {} },
      } as never,
    })
  })

  it('measures a local engine other than llama.cpp through the core', async () => {
    select('vllm')
    measureContext.mockResolvedValue({
      promptTokens: 2048,
      exact: true,
      windowTokens: 8192,
      resize: 'restart',
      supportsPromptProgress: false,
    })

    const { result } = renderHook(() => useTokensCount(history))

    await waitFor(() => expect(result.current.tokenCount).toBe(2048), {
      timeout: 2000,
    })
    expect(result.current.maxTokens).toBe(8192)
    expect(result.current.windowTokens).toBe(8192)
    expect(measureContext).toHaveBeenCalledWith('vllm', 'fixture-model', {
      messages: [
        { role: 'user', content: 'What makes tides?' },
        { role: 'assistant', content: 'The moon.' },
        { role: 'user', content: 'Neap tides?' },
      ],
    })
    expect(getTokensCount).not.toHaveBeenCalled()
  })

  it('keeps the llama.cpp tokenizer for llama.cpp', async () => {
    select('llamacpp-upstream')
    getTokensCount.mockResolvedValue(321)

    const { result } = renderHook(() => useTokensCount(history))

    await waitFor(() => expect(result.current.tokenCount).toBe(321), {
      timeout: 2000,
    })
    expect(result.current.maxTokens).toBe(4096)
    expect(measureContext).not.toHaveBeenCalled()
  })

  it('counts the summary and the kept messages after a compaction', async () => {
    select('foundry-local')
    useThreads.setState({
      threads: {
        [THREAD]: {
          id: THREAD,
          title: 'Tides',
          updated: 0,
          metadata: {
            compaction: {
              summary: 'Tides come from the moon.',
              upToMessageId: 'u2',
              summarizedCount: 2,
              tokensBefore: 900,
              tokensAfter: 300,
              modelId: 'fixture-model',
              provider: 'foundry-local',
              createdAt: 1,
            },
          },
        },
      } as never,
    })
    measureContext.mockResolvedValue({
      promptTokens: 300,
      exact: false,
      resize: 'fixed',
      supportsPromptProgress: false,
    })

    const { result } = renderHook(() => useTokensCount(history))

    await waitFor(() => expect(result.current.tokenCount).toBe(300), {
      timeout: 2000,
    })
    expect(measureContext.mock.calls[0][2].messages).toEqual([
      { role: 'system', content: summaryBlock('Tides come from the moon.') },
      { role: 'user', content: 'Neap tides?' },
    ])
  })

  it('counts nothing for a cloud model', async () => {
    select('openai')
    const { result } = renderHook(() => useTokensCount(history))
    await new Promise((resolve) => setTimeout(resolve, 600))
    expect(result.current.tokenCount).toBe(0)
    expect(measureContext).not.toHaveBeenCalled()
    expect(getTokensCount).not.toHaveBeenCalled()
  })
})
