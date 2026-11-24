import { beforeEach, describe, expect, it, vi } from 'vitest'
import { streamText } from 'ai'
import type { ProviderObject } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'

import {
  ModelFactory,
  readPromptProgress,
  withPromptProgress,
  withReturnProgress,
} from '../model-factory'
import { useAppState, type PromptProgress } from '@/hooks/useAppState'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null
  },
}))

vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))

const mockedInvoke = vi.mocked(invoke)

/** What llama-server streams with `return_progress: true` while it reads the prompt. */
const progressChunk = (processed: number, total = 4096) => ({
  choices: [
    {
      finish_reason: null,
      index: 0,
      delta: { role: 'assistant', content: null },
    },
  ],
  created: 1758113912,
  id: 'chatcmpl-1',
  model: 'qwen',
  system_fingerprint: 'b1-e4912fc',
  object: 'chat.completion.chunk',
  prompt_progress: { total, cache: 0, processed, time_ms: 120 },
})

const contentChunk = (content: string) => ({
  choices: [{ finish_reason: null, index: 0, delta: { content } }],
  created: 1758113912,
  id: 'chatcmpl-1',
  model: 'qwen',
  object: 'chat.completion.chunk',
})

const finishChunk = {
  choices: [{ finish_reason: 'stop', index: 0, delta: {} }],
  created: 1758113912,
  id: 'chatcmpl-1',
  model: 'qwen',
  object: 'chat.completion.chunk',
  usage: { prompt_tokens: 4096, completion_tokens: 2, total_tokens: 4098 },
}

const innerExtractor = () => {
  const processed: unknown[] = []
  return {
    processed,
    extractor: {
      extractMetadata: vi.fn(async () => undefined),
      createStreamExtractor: () => ({
        processChunk: (chunk: unknown) => {
          processed.push(chunk)
        },
        buildMetadata: () => ({ providerMetadata: { seen: processed.length } }),
      }),
    },
  }
}

describe('readPromptProgress', () => {
  it('reads llama-server’s prompt_progress and nothing else', () => {
    expect(readPromptProgress(progressChunk(1024))).toEqual({
      total: 4096,
      cache: 0,
      processed: 1024,
      time_ms: 120,
    })
    expect(readPromptProgress(contentChunk('Hi'))).toBeUndefined()
    expect(
      readPromptProgress({ prompt_progress: { total: 0, processed: 0 } })
    ).toBeUndefined()
    expect(readPromptProgress(null)).toBeUndefined()
  })
})

describe('withReturnProgress', () => {
  it('asks only a streamed request for the reading progress', () => {
    expect(withReturnProgress({ stream: true, model: 'm' })).toEqual({
      stream: true,
      model: 'm',
      return_progress: true,
    })
    expect(withReturnProgress({ model: 'm' })).toEqual({ model: 'm' })
  })
})

describe('withPromptProgress', () => {
  it('reports the reading progress and takes it back at the first token', () => {
    const report = vi.fn()
    const { extractor, processed } = innerExtractor()
    const stream = withPromptProgress(extractor, report).createStreamExtractor()

    stream.processChunk(progressChunk(2048))
    stream.processChunk(progressChunk(4096))
    stream.processChunk(contentChunk('Hel'))
    stream.processChunk(contentChunk('lo'))

    expect(report.mock.calls).toEqual([
      [{ total: 4096, cache: 0, processed: 2048, time_ms: 120 }],
      [{ total: 4096, cache: 0, processed: 4096, time_ms: 120 }],
      [undefined],
    ])
    // The metrics extractor still sees every chunk.
    expect(processed).toHaveLength(4)
    expect(stream.buildMetadata()).toEqual({ providerMetadata: { seen: 4 } })
    expect(report).toHaveBeenCalledTimes(3)
  })

  it('takes the progress back at the finish when no token came', () => {
    const reports: unknown[] = []
    const stream = withPromptProgress(innerExtractor().extractor, (progress) =>
      reports.push(progress)
    ).createStreamExtractor()
    stream.processChunk(progressChunk(100))
    expect(stream.buildMetadata()).toEqual({ providerMetadata: { seen: 1 } })
    expect(reports).toEqual([
      { total: 4096, cache: 0, processed: 100, time_ms: 120 },
      undefined,
    ])
  })

  it('leaves the progress alone for a stream that reported none', () => {
    const reports: unknown[] = []
    const stream = withPromptProgress(innerExtractor().extractor, (progress) =>
      reports.push(progress)
    ).createStreamExtractor()
    stream.processChunk(contentChunk('Hi'))
    stream.processChunk(finishChunk)
    expect(stream.buildMetadata()).toEqual({ providerMetadata: { seen: 2 } })
    // Another stream's progress is not taken back by this one.
    expect(reports).toEqual([])
  })
})

describe('a llama.cpp chat stream with prompt_progress', () => {
  const provider = {
    provider: 'llamacpp-upstream',
    api_key: '',
    base_url: 'http://localhost',
    models: [],
    settings: [],
    active: true,
  } as unknown as ProviderObject

  beforeEach(() => {
    vi.clearAllMocks()
    seedServiceHub({
      models: {
        startModel: vi.fn().mockResolvedValue(undefined),
      } as unknown as ModelsService,
    })
    ModelFactory.invalidateLocalSessionCache('llamacpp-upstream', 'qwen')
    useAppState.setState({ promptProgress: undefined })
  })

  it('asks for the progress, shows it while reading and still parses the answer', async () => {
    const sentBodies: Record<string, unknown>[] = []
    const seen: Array<PromptProgress | undefined> = []
    const unsubscribe = useAppState.subscribe((state, previous) => {
      if (state.promptProgress !== previous.promptProgress) {
        seen.push(state.promptProgress)
      }
    })
    mockedInvoke.mockImplementation(async (command, args) => {
      if (command === 'resolve_local_session') {
        return { pid: 1, port: 4100, model_id: 'qwen', api_key: 'k' }
      }
      if (command === 'stream_local_http') {
        const { body, onChunk } = args as {
          body: string
          onChunk: {
            onmessage: (message: { data: string; done?: boolean }) => void
          }
        }
        sentBodies.push(JSON.parse(body))
        const events = [
          progressChunk(2048),
          progressChunk(4096),
          contentChunk('Hel'),
          contentChunk('lo'),
          finishChunk,
        ]
        queueMicrotask(() => {
          for (const event of events) {
            onChunk.onmessage({ data: `data: ${JSON.stringify(event)}\n\n` })
          }
          onChunk.onmessage({ data: 'data: [DONE]\n\n' })
          onChunk.onmessage({ data: '', done: true })
        })
        return 200
      }
      return null
    })

    const model = await ModelFactory.createModel('qwen', provider)
    const result = streamText({ model, prompt: 'hi' })
    const text = await result.text
    unsubscribe()

    expect(text).toBe('Hello')
    expect(await result.finishReason).toBe('stop')
    expect(sentBodies).toHaveLength(1)
    expect(sentBodies[0]).toMatchObject({ stream: true, return_progress: true })
    expect(seen).toEqual([
      { total: 4096, cache: 0, processed: 2048, time_ms: 120 },
      { total: 4096, cache: 0, processed: 4096, time_ms: 120 },
      undefined,
    ])
    expect(useAppState.getState().promptProgress).toBeUndefined()
  })
})
