import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

import type {
  EngineVersions,
  EngineVersionsRequest,
  EngineVersionsResponse,
} from '@/services/engines/types'

type Handler = (event: { payload: unknown }) => void
const handlers = new Map<string, Handler>()
const unlistened: string[] = []
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: Handler) => {
    handlers.set(name, handler)
    return () => {
      unlistened.push(name)
      handlers.delete(name)
    }
  },
}))

const engineVersions =
  vi.fn<(request?: EngineVersionsRequest) => Promise<EngineVersionsResponse>>()
vi.mock('@/services/engines/core', () => ({
  engineVersions: (request?: EngineVersionsRequest) => engineVersions(request),
}))

const { useEngineVersionsStore, selectEngineVersions } = await import(
  '../engine-versions-store'
)

const entry = (
  engine: EngineVersions['engine'],
  patch: Partial<EngineVersions> = {}
): EngineVersions => ({
  engine,
  kind: 'llamacpp',
  active_choice: 'client',
  builds: [],
  active: { version: 'b11400', variant: 'macos-arm64' },
  latest: null,
  update: { needed: false, target: null, apply: 'swap' },
  source: 'remote',
  source_error: null,
  error: null,
  ...patch,
})

/** A call the test answers when it chooses. */
function deferred() {
  let resolve!: (value: EngineVersionsResponse) => void
  let reject!: (error: unknown) => void
  const promise = new Promise<EngineVersionsResponse>((res, rej) => {
    resolve = res
    reject = rej
  })
  return { promise, resolve, reject }
}

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

const emit = (name: string, payload: unknown = {}) => {
  const handler = handlers.get(`atomic-core://${name}`)
  if (!handler) throw new Error(`no listener for ${name}`)
  handler({ payload })
}

describe('engine versions store', () => {
  beforeEach(() => {
    handlers.clear()
    unlistened.length = 0
    engineVersions.mockReset()
    engineVersions.mockResolvedValue({ engines: [entry('llamacpp-upstream')] })
    useEngineVersionsStore.getState().reset()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  it('keeps the last answer per engine, each with its own error', async () => {
    engineVersions.mockResolvedValue({
      engines: [
        entry('llamacpp-upstream'),
        entry('mlx', {
          kind: 'engine-build',
          active_choice: 'core',
          error: { code: 'UPSTREAM_ERROR', message: 'manifest unreachable' },
        }),
      ],
    })

    await useEngineVersionsStore.getState().refresh()

    const state = useEngineVersionsStore.getState()
    expect(state.error).toBeNull()
    expect(selectEngineVersions(state, 'llamacpp-upstream')?.error).toBeNull()
    expect(selectEngineVersions(state, 'mlx')?.error?.code).toBe(
      'UPSTREAM_ERROR'
    )
    expect(selectEngineVersions(state, 'vllm')).toBeUndefined()
    expect(engineVersions).toHaveBeenCalledWith(
      expect.objectContaining({ app_version: 'test' })
    )
  })

  it('keeps the previous answer when a whole request fails, and says why', async () => {
    await useEngineVersionsStore.getState().refresh()
    engineVersions.mockRejectedValueOnce({
      code: 'CORE_UNREACHABLE',
      message: 'The Atomic Chat core did not answer.',
    })

    await useEngineVersionsStore.getState().refresh()

    const state = useEngineVersionsStore.getState()
    expect(state.error?.code).toBe('CORE_UNREACHABLE')
    expect(selectEngineVersions(state, 'llamacpp-upstream')).toBeDefined()
  })

  it('passes force only for the buttons’ refresh', async () => {
    await useEngineVersionsStore.getState().refresh({ force: true })
    await useEngineVersionsStore.getState().refresh()
    expect(engineVersions.mock.calls[0][0]?.force).toBe(true)
    expect(engineVersions.mock.calls[1][0]?.force).toBeUndefined()
  })

  it('runs one request at a time and folds the calls made meanwhile into one more', async () => {
    const first = deferred()
    const second = deferred()
    engineVersions
      .mockReturnValueOnce(first.promise)
      .mockReturnValueOnce(second.promise)

    const a = useEngineVersionsStore.getState().refresh()
    const b = useEngineVersionsStore.getState().refresh()
    const c = useEngineVersionsStore.getState().refresh({ force: true })
    expect(engineVersions).toHaveBeenCalledTimes(1)
    expect(useEngineVersionsStore.getState().loading).toBe(true)

    first.resolve({ engines: [entry('llamacpp-upstream')] })
    await a
    await flush()
    // The calls that came during the first one ran together after it, forced
    // because one of them asked to be.
    expect(engineVersions).toHaveBeenCalledTimes(2)
    expect(engineVersions.mock.calls[1][0]?.force).toBe(true)

    second.resolve({
      engines: [
        entry('llamacpp-upstream', {
          active: { version: 'b11500', variant: 'macos-arm64' },
        }),
      ],
    })
    await Promise.all([b, c])
    const state = useEngineVersionsStore.getState()
    expect(state.loading).toBe(false)
    expect(
      selectEngineVersions(state, 'llamacpp-upstream')?.active?.version
    ).toBe('b11500')
  })

  describe('bind', () => {
    it('asks once on bind', async () => {
      const unbind = useEngineVersionsStore.getState().bind()
      await flush()
      expect(engineVersions).toHaveBeenCalledTimes(1)
      unbind()
    })

    it.each([
      ['snapshot', { generation: 2 }],
      ['engine:changed', { engine: 'llamacpp-upstream', reason: 'update' }],
      ['environment:changed', { environment_id: 'env-1' }],
      [
        'settings:changed',
        {
          provider: 'llamacpp-upstream',
          key: 'version_backend',
          value: 'b11500/macos-arm64',
        },
      ],
    ])('asks again on %s', async (name, payload) => {
      const unbind = useEngineVersionsStore.getState().bind()
      await flush()
      engineVersions.mockClear()

      emit(name, payload)
      await flush()

      expect(engineVersions).toHaveBeenCalledTimes(1)
      unbind()
    })

    it('ignores a settings change of any other key', async () => {
      const unbind = useEngineVersionsStore.getState().bind()
      await flush()
      engineVersions.mockClear()

      emit('settings:changed', {
        provider: 'llamacpp-upstream',
        key: 'ctx_size',
        value: 8192,
      })
      await flush()

      expect(engineVersions).not.toHaveBeenCalled()
      unbind()
    })

    it('stops listening on unbind', async () => {
      const unbind = useEngineVersionsStore.getState().bind()
      await flush()
      unbind()
      await flush()
      expect(unlistened.sort()).toEqual(
        [
          'atomic-core://engine:changed',
          'atomic-core://environment:changed',
          'atomic-core://settings:changed',
          'atomic-core://snapshot',
        ].sort()
      )
    })
  })
})
