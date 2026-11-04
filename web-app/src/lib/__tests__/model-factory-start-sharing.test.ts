import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { ProviderObject } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { OpenAICompatibleChatLanguageModel } from '@ai-sdk/openai-compatible'
import type { ModelsService } from '@/services/models/types'
import { seedServiceHub } from '@/test/service-hub'
import {
  heldModels,
  pendingModelStart,
  resetModelLifecycleForTests,
  shareModelStart,
} from '@/lib/model-lifecycle'
import { ModelFactory, createHoldingFetch } from '../model-factory'

vi.mock('@tauri-apps/api/core', () => ({
  invoke: vi.fn(),
  Channel: class {
    onmessage: ((message: unknown) => void) | null = null
  },
}))
vi.mock('@tauri-apps/plugin-http', () => ({ fetch: vi.fn() }))
vi.mock('@ai-sdk/openai-compatible', () => ({
  createOpenAICompatible: vi.fn(),
  OpenAICompatibleChatLanguageModel: vi.fn().mockImplementation(() => ({})),
  MetadataExtractor: vi.fn(),
}))
vi.mock('ai', () => ({
  wrapLanguageModel: vi.fn(({ model }) => model),
  extractReasoningMiddleware: vi.fn(() => ({})),
}))

const mockedInvoke = vi.mocked(invoke)
const startModel = vi.fn()

const provider = {
  provider: 'llamacpp-upstream',
  models: [],
  settings: [],
  active: true,
} as unknown as ProviderObject

const session = (modelId: string) => ({
  model_id: modelId,
  port: 4555,
  api_key: 'session-key',
})

/** `resolve_local_session` answers `null` until `serving()` says the model is up. */
function engineServing(modelId: string, serving: () => boolean) {
  mockedInvoke.mockImplementation(async (command) =>
    command === 'resolve_local_session' && serving() ? session(modelId) : null
  )
}

beforeEach(() => {
  vi.clearAllMocks()
  resetModelLifecycleForTests()
  startModel.mockResolvedValue(undefined)
  seedServiceHub({ models: { startModel } as unknown as ModelsService })
})

describe('a send while its model is still starting', () => {
  it('waits for the start under way instead of starting the model again', async () => {
    let loaded = false
    let finish!: () => void
    shareModelStart(
      'llamacpp-upstream',
      'join-ok',
      new Promise<void>((resolve) => {
        finish = () => {
          loaded = true
          resolve()
        }
      })
    )
    engineServing('join-ok', () => loaded)

    const created = ModelFactory.createModel('join-ok', provider)
    await Promise.resolve()
    finish()
    await created

    expect(startModel).not.toHaveBeenCalled()
    const config = vi.mocked(OpenAICompatibleChatLanguageModel).mock
      .calls[0][1] as unknown as { url: (o: { path: string }) => string }
    // llama-server binds 127.0.0.1 only; `localhost` tries ::1 first on Windows.
    expect(config.url({ path: '/chat/completions' })).toBe(
      'http://127.0.0.1:4555/v1/chat/completions'
    )
  })

  it('fails with the joined load’s error rather than loading again', async () => {
    shareModelStart(
      'llamacpp-upstream',
      'join-failed',
      Promise.reject(new Error('out of memory'))
    )
    engineServing('join-failed', () => false)

    await expect(
      ModelFactory.createModel('join-failed', provider)
    ).rejects.toThrow('Failed to start model: out of memory')
    expect(startModel).not.toHaveBeenCalled()
  })

  it('starts the model itself when the joined start ended without it', async () => {
    shareModelStart('llamacpp-upstream', 'join-empty', Promise.resolve())
    let loaded = false
    startModel.mockImplementation(async () => {
      loaded = true
    })
    engineServing('join-empty', () => loaded)

    await ModelFactory.createModel('join-empty', provider)

    expect(startModel).toHaveBeenCalledTimes(1)
    expect(loaded).toBe(true)
  })

  it('shares its own start, and holds the model while it loads', async () => {
    let finish!: () => void
    startModel.mockReturnValue(
      new Promise<void>((resolve) => {
        finish = resolve
      })
    )
    let loaded = false
    engineServing('own-start', () => loaded)

    const created = ModelFactory.createModel('own-start', provider)
    await vi.waitFor(() =>
      expect(pendingModelStart('llamacpp-upstream', 'own-start')).toBeDefined()
    )
    expect(heldModels()).toContainEqual({
      provider: 'llamacpp-upstream',
      modelId: 'own-start',
    })

    loaded = true
    finish()
    await created
    expect(startModel).toHaveBeenCalledTimes(1)
  })
})

describe('createHoldingFetch', () => {
  const ref = { provider: 'llamacpp-upstream', modelId: 'held' }

  it('holds the model from creation until the response has been read', async () => {
    const inner = vi.fn(async () => new Response('data: done\n\n'))
    const fetch = createHoldingFetch(ref.provider, ref.modelId, inner)
    // Built, not yet sent: the request is on its way.
    expect(heldModels()).toEqual([ref])

    const response = await fetch('http://127.0.0.1:4555/v1/chat/completions')
    expect(heldModels()).toEqual([ref])

    await expect(response.text()).resolves.toBe('data: done\n\n')
    expect(heldModels()).toEqual([])
  })

  it('lets go when the request fails or the reader walks away', async () => {
    const failing = createHoldingFetch(ref.provider, ref.modelId, async () => {
      throw new Error('connect refused')
    })
    await expect(failing('http://127.0.0.1:1/v1/x')).rejects.toThrow(
      'connect refused'
    )
    expect(heldModels()).toEqual([])

    const streaming = createHoldingFetch(
      ref.provider,
      ref.modelId,
      async () =>
        new Response(
          new ReadableStream({
            pull(controller) {
              controller.enqueue(new TextEncoder().encode('chunk'))
            },
          })
        )
    )
    const response = await streaming('http://127.0.0.1:4555/v1/x')
    expect(heldModels()).toEqual([ref])
    await response.body!.cancel()
    expect(heldModels()).toEqual([])
  })
})
