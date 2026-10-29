import { act, renderHook, waitFor } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const { findLocalSession, listeners, activeIn, serviceHub } = vi.hoisted(() => {
  const activeIn = { provider: 'llamacpp-upstream' }
  return {
    findLocalSession: vi.fn(),
    listeners: new Map<string, () => void>(),
    activeIn,
    // One hub for every render, as the app's is.
    serviceHub: {
      models: () => ({
        getActiveModels: async (provider?: string) =>
          provider === activeIn.provider ? [MODEL] : [],
      }),
    },
  }
})

vi.mock('@/lib/model-factory', () => ({ findLocalSession }))

vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async (name: string, handler: () => void) => {
    listeners.set(name, handler)
    return () => listeners.delete(name)
  }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => serviceHub,
}))

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'

import { useServedContextLength } from '../useServedContextLength'

const MODEL = 'LiquidAI/LFM2.5-1.2B-Instruct-GGUF/LFM2.5-1.2B-Instruct-Q4_K_M'

/** `provider`'s copy of the model, with its own `ctx_len`. */
const engine = (provider: string, ctxLen: number) => ({
  provider,
  active: true,
  settings: [],
  models: [
    {
      id: MODEL,
      settings: {
        ctx_len: { key: 'ctx_len', controller_props: { value: ctxLen } },
      },
    },
  ],
})

const props = (nCtx: number) =>
  ({
    ok: true,
    json: async () => ({ default_generation_settings: { n_ctx: nCtx } }),
  }) as Response

const fetchMock = vi.fn()

describe('useServedContextLength', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    listeners.clear()
    activeIn.provider = 'llamacpp-upstream'
    vi.stubGlobal('fetch', fetchMock)
    // Both llama.cpp providers list the same models folder, TurboQuant first:
    // its copy keeps the default while chat set llama.cpp's to 4,096.
    useModelProvider.setState({
      providers: [
        engine('llamacpp', 16384),
        engine('llamacpp-upstream', 4096),
      ] as never,
    })
    useLocalApiServer.setState({
      lastServerModels: [{ model: MODEL, provider: 'llamacpp-upstream' }],
      defaultModelLocalApiServer: null,
    })
    findLocalSession.mockResolvedValue({ port: 41000, api_key: 'session-key' })
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it("reads the window of the running session from the engine that holds it, not TurboQuant's setting", async () => {
    // The core grew the window past the setting when a request overflowed it.
    fetchMock.mockResolvedValue(props(8192))
    const { result } = renderHook(() => useServedContextLength(MODEL))

    await waitFor(() => expect(result.current).toBe(8192))
    expect(findLocalSession).toHaveBeenCalledWith('llamacpp-upstream', MODEL)
    expect(fetchMock).toHaveBeenCalledWith('http://127.0.0.1:41000/props', {
      headers: { Authorization: 'Bearer session-key' },
    })
  })

  it("falls back to the serving engine's own setting when the session cannot say", async () => {
    fetchMock.mockRejectedValue(new Error('connection refused'))
    const { result } = renderHook(() => useServedContextLength(MODEL))

    await waitFor(() => expect(result.current).toBe(4096))
  })

  it('asks the engines which one holds the model when the server did not record it', async () => {
    useLocalApiServer.setState({ lastServerModels: [] })
    activeIn.provider = 'llamacpp'
    fetchMock.mockRejectedValue(new Error('connection refused'))
    const { result } = renderHook(() => useServedContextLength(MODEL))

    await waitFor(() => expect(result.current).toBe(16384))
    expect(findLocalSession).toHaveBeenCalledWith('llamacpp', MODEL)
  })

  it.each([
    'atomic-core://session:started',
    'atomic-core://session:ctx-increased',
  ])('reads the window again after %s', async (event) => {
    fetchMock.mockResolvedValue(props(4096))
    const { result } = renderHook(() => useServedContextLength(MODEL))
    await waitFor(() => expect(result.current).toBe(4096))
    await waitFor(() => expect(listeners.has(event)).toBe(true))

    fetchMock.mockResolvedValue(props(32768))
    act(() => listeners.get(event)?.())

    await waitFor(() => expect(result.current).toBe(32768))
  })

  it('names no window for an engine with no context setting of its own', async () => {
    useModelProvider.setState({ providers: [engine('vllm', 16384)] as never })
    useLocalApiServer.setState({
      lastServerModels: [{ model: MODEL, provider: 'vllm' }],
    })
    activeIn.provider = 'vllm'
    const { result } = renderHook(() => useServedContextLength(MODEL))

    // Long enough for the engine to have been asked and the answer applied.
    await act(() => new Promise((resolve) => setTimeout(resolve, 50)))
    expect(findLocalSession).not.toHaveBeenCalled()
    expect(result.current).toBeUndefined()
    expect(fetchMock).not.toHaveBeenCalled()
  })

  it('names none without a loaded model', () => {
    const { result } = renderHook(() => useServedContextLength(null))
    expect(result.current).toBeUndefined()
  })
})
