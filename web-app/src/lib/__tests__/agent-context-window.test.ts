import { beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  getMaxCtxTrain: vi.fn<(id: string) => Promise<number | undefined>>(),
  // The window the running session reports (`/props`), per load.
  windows: [] as Array<number | undefined>,
  load: vi.fn(),
  stopModel: vi.fn(),
}))

vi.mock('@janhq/core', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@janhq/core')>()
  return {
    ...actual,
    EngineManager: {
      instance: () => ({
        get: () => ({ getMaxCtxTrain: mocks.getMaxCtxTrain }),
      }),
    },
  }
})
vi.mock('@/hooks/useServiceHub', () => ({
  getServiceHub: () => ({ models: () => ({ stopModel: mocks.stopModel }) }),
}))
vi.mock('@/utils/servedModel', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/servedModel')>()),
  servedContextLength: vi.fn(async () => mocks.windows[0]),
  loadServedModel: mocks.load,
}))

import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { useModelProvider } from '@/hooks/useModelProvider'
import { readModelCtxLen } from '@/lib/context-size'

import {
  AgentContextError,
  contextWindowMessage,
  ensureAgentContextWindow,
  formatContextTokens,
  requireAgentContextWindow,
} from '../agent-context-window'

const agent = (id: string) => INTEGRATION_AGENTS.find((a) => a.id === id)!
const SERVED = { provider: 'llamacpp-upstream', model: 'qwen' }
const t = (key: string, params?: Record<string, unknown>) =>
  params ? `${key}:${JSON.stringify(params)}` : key

function seed(ctxLen: number, fit = false) {
  useModelProvider.setState({
    providers: [
      {
        provider: 'llamacpp-upstream',
        active: true,
        models: [
          {
            id: 'qwen',
            settings: { ctx_len: { controller_props: { value: ctxLen } } },
          },
        ],
        settings: [{ key: 'fit', controller_props: { value: fit } }],
      },
    ] as never,
  })
}

function ctxLenInStore(): number | undefined {
  return readModelCtxLen(
    useModelProvider
      .getState()
      .providers[0]?.models.find((m) => m.id === 'qwen') as never
  )
}

describe('ensureAgentContextWindow', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    mocks.getMaxCtxTrain.mockResolvedValue(undefined)
    mocks.stopModel.mockResolvedValue(undefined)
    // Each successful load reports the next window.
    mocks.load.mockImplementation(async () => {
      mocks.windows.shift()
      return { status: 'loaded' }
    })
  })

  it('leaves a window it cannot read, or one big enough, alone', async () => {
    seed(16384)
    mocks.windows = [undefined]
    await expect(
      ensureAgentContextWindow(agent('codex'), SERVED)
    ).resolves.toEqual({
      ok: true,
      contextLength: undefined,
    })
    mocks.windows = [65536]
    await expect(
      ensureAgentContextWindow(agent('hermes'), SERVED)
    ).resolves.toEqual({
      ok: true,
      contextLength: 65536,
    })
    // Editors have no minimum.
    mocks.windows = [4096]
    await expect(
      ensureAgentContextWindow(agent('vscode'), SERVED)
    ).resolves.toEqual({
      ok: true,
      contextLength: 4096,
    })
    expect(ctxLenInStore()).toBe(16384)
    expect(mocks.load).not.toHaveBeenCalled()
  })

  it('reloads a model below the minimum with at least that, and reports the new window', async () => {
    seed(16384)
    mocks.windows = [16384, 32768]

    const window = await ensureAgentContextWindow(agent('codex'), SERVED)

    expect(window).toEqual({ ok: true, contextLength: 32768 })
    expect(ctxLenInStore()).toBe(32768)
    expect(mocks.load).toHaveBeenCalledOnce()
  })

  it('asks Hermes’ 64K of the ladder in one reload', async () => {
    seed(16384)
    mocks.windows = [16384, 73728]

    const window = await ensureAgentContextWindow(agent('hermes'), SERVED)

    expect(window).toEqual({ ok: true, contextLength: 73728 })
    expect(ctxLenInStore()).toBeGreaterThanOrEqual(65536)
    expect(mocks.load).toHaveBeenCalledOnce()
  })

  it('does not touch a window "Fit to device memory" sizes', async () => {
    seed(16384, true)
    mocks.windows = [16384]

    const window = await ensureAgentContextWindow(agent('codex'), SERVED)

    expect(window).toEqual({
      ok: false,
      reason: 'fit',
      minimum: 32768,
      contextLength: 16384,
    })
    expect(ctxLenInStore()).toBe(16384)
    expect(mocks.stopModel).not.toHaveBeenCalled()
  })

  it('stops before reloading a model trained shorter than the minimum', async () => {
    seed(16384)
    mocks.windows = [16384]
    mocks.getMaxCtxTrain.mockResolvedValue(40960)

    const window = await ensureAgentContextWindow(agent('hermes'), SERVED)

    expect(window).toEqual({
      ok: false,
      reason: 'model_max',
      minimum: 65536,
      contextLength: 40960,
    })
    expect(ctxLenInStore()).toBe(16384)
    expect(mocks.stopModel).not.toHaveBeenCalled()
  })

  it('puts the old window back and reloads it when the bigger one does not load', async () => {
    seed(16384)
    mocks.windows = [16384]
    mocks.load
      .mockRejectedValueOnce(new Error('out of memory'))
      .mockResolvedValueOnce({ status: 'loaded' })

    const window = await ensureAgentContextWindow(agent('codex'), SERVED)

    expect(window).toEqual({
      ok: false,
      reason: 'reload',
      minimum: 32768,
      contextLength: 16384,
    })
    expect(ctxLenInStore()).toBe(16384)
    expect(mocks.load).toHaveBeenCalledTimes(2)
  })

  it('says so when the engine still reports less after the reload', async () => {
    seed(16384)
    mocks.windows = [16384, 24576]

    const window = await ensureAgentContextWindow(agent('codex'), SERVED)

    expect(window).toMatchObject({
      ok: false,
      reason: 'model_max',
      contextLength: 24576,
    })
  })
})

describe('the message and the error Connect stops with', () => {
  it('names the agent, its minimum and why it cannot be had', async () => {
    seed(16384, true)
    mocks.windows = [16384]

    const error = await requireAgentContextWindow(
      agent('hermes'),
      t,
      SERVED
    ).catch((e: unknown) => e)

    expect(error).toBeInstanceOf(AgentContextError)
    const { title, description } = error as AgentContextError
    expect(title).toBe(
      'launch:toast.contextTooSmall:{"name":"Hermes Agent","minimum":"64K"}'
    )
    expect(description).toBe(
      'launch:toast.contextTooSmallFit:{"current":"16K"}'
    )
    expect((error as Error).message).toBe(`${title}. ${description}`)
  })

  it('words each reason', () => {
    const failure = { ok: false as const, minimum: 32768, contextLength: 20000 }
    expect(
      contextWindowMessage(t, agent('codex'), {
        ...failure,
        reason: 'model_max',
      }).description
    ).toBe('launch:toast.contextTooSmallModel:{"current":"20000"}')
    expect(
      contextWindowMessage(t, agent('codex'), { ...failure, reason: 'reload' })
        .description
    ).toBe('launch:toast.contextTooSmallMemory:{"current":"20000"}')
    expect(formatContextTokens(32768)).toBe('32K')
  })
})
