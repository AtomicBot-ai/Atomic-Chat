import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useModelProvider } from '@/hooks/useModelProvider'
import { initializeServiceHubStore } from '@/hooks/useServiceHub'
import {
  makeFakeDiffusion,
  makeLoadedStatus,
  makeStatus,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { createMockServiceHub } from '@/test/service-hub'

const {
  toastInfo,
  toastWarning,
  toastError,
  toastDismiss,
  setRunning,
  ensureModel,
  turnOff,
  resume,
} = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  setRunning: vi.fn(),
  ensureModel: vi.fn(),
  turnOff: vi.fn(),
  resume: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: {
    info: toastInfo,
    warning: toastWarning,
    error: toastError,
    dismiss: toastDismiss,
  },
}))
vi.mock('@/utils/localApiServerControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/localApiServerControl')>()),
  setLocalApiServerRunning: setRunning,
  stopLocalApiServer: vi.fn(),
}))
// Only the load is faked; which provider gets recorded is the real lookup.
vi.mock('@/utils/ensureModelForServer', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/ensureModelForServer')>()),
  ensureModelForServer: ensureModel,
}))
vi.mock('@/utils/turnOffLocalApiServer', () => ({
  turnOffLocalApiServer: turnOff,
  resumeServedHelperModels: resume,
}))
vi.mock('@/utils/activeModelsSync', () => ({
  hydrateActiveModelsForRunningServer: vi.fn(),
  syncActiveModelsFromEngines: vi.fn(),
}))

import { useLocalApiServerControl } from '../useLocalApiServerControl'

/** The port the core actually bound, as the store learns it while the server starts. */
function bindsPort(port: number): void {
  setRunning.mockImplementation(async () => {
    useLocalApiServer.getState().setServerPort(port)
  })
}

describe('starting the local API server', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useLocalApiServer.getState().setServerPort(1337)
    initializeServiceHubStore(
      createMockServiceHub({
        app: { getServerStatus: vi.fn().mockResolvedValue(false) } as never,
      })
    )
  })

  // The core takes a free port when the configured one is busy — another Atomic Chat, Ollama,
  // anything. The store follows it, so the app works; the user's own clients do not, because they
  // are pointed at the port the user set. Silence there is a refused connection with no cause.
  it('says so when the core had to bind a different port', async () => {
    bindsPort(1338)
    const { result } = renderHook(() => useLocalApiServerControl())
    // The mount effect asks the app service whether a server is already running.
    await act(async () => {})

    await act(async () => {
      await result.current.start({ ensureModel: false })
    })

    await waitFor(() => expect(toastWarning).toHaveBeenCalledTimes(1))
    const [title, options] = toastWarning.mock.calls[0] as [
      string,
      { description: string },
    ]
    expect(title).toBe('Server started on a different port')
    expect(options.description).toContain('1337')
    expect(options.description).toContain('1338')
  })

  it('stays quiet when the configured port was free', async () => {
    bindsPort(1337)
    const { result } = renderHook(() => useLocalApiServerControl())
    // The mount effect asks the app service whether a server is already running.
    await act(async () => {})

    await act(async () => {
      await result.current.start({ ensureModel: false })
    })

    // The port the user configured is the port that is serving, so there is nothing to say.
    expect(useLocalApiServer.getState().serverPort).toBe(1337)
    expect(toastWarning).not.toHaveBeenCalled()
  })
})

/** A llama.cpp provider that lists `ids` from the shared models folder. */
const llamacppProvider = (provider: string, ids: string[]) =>
  ({
    provider,
    active: true,
    models: ids.map((id) => ({ id })),
  }) as unknown as ModelProvider

describe('what Start loads before the server comes up', () => {
  const models = {
    getActiveModels: vi.fn(async (_provider?: string) => [] as string[]),
    startModel: vi.fn(),
    stopModel: vi.fn(),
  }
  let diffusion: ReturnType<typeof makeFakeDiffusion>

  beforeEach(() => {
    vi.clearAllMocks()
    useLocalApiServer.getState().setServerPort(1337)
    useLocalApiServer.getState().setLastServerModels([])
    bindsPort(1337)
    diffusion = makeFakeDiffusion()
    initializeServiceHubStore(
      createMockServiceHub({
        app: { getServerStatus: vi.fn().mockResolvedValue(false) } as never,
        models: models as never,
        diffusion,
      })
    )
    // Both llama.cpp providers list the same models folder, TurboQuant first, as they do on a
    // real install; the server's default is the upstream one.
    useModelProvider.setState({
      providers: [
        llamacppProvider('llamacpp', ['gemma']),
        llamacppProvider('llamacpp-upstream', ['gemma']),
      ],
    })
    useLocalApiServer.getState().setDefaultModelLocalApiServer({
      model: 'gemma',
      provider: 'llamacpp-upstream',
    })
    // Loading the chat model does what it does on a machine that cannot hold both: the GPU
    // arbiter unloads the image model to make room. The upstream engine then holds the session,
    // and each engine reports only its own sessions.
    ensureModel.mockImplementation(async () => {
      diffusion.emit({ type: 'state', status: makeStatus() })
      models.getActiveModels.mockImplementation(async (provider?: string) =>
        provider === undefined || provider === 'llamacpp-upstream'
          ? ['gemma']
          : []
      )
      return {
        status: 'loaded',
        modelId: 'gemma',
        providerName: 'llamacpp-upstream',
      }
    })
  })

  async function pressStart(): Promise<void> {
    const { result } = renderHook(() => useLocalApiServerControl())
    // The mount effect asks the app service whether a server is already running.
    await act(async () => {})
    await act(async () => {
      await result.current.start()
    })
  }

  // The image or video model is what the server serves then. A chat model loaded "for" the server
  // could unload it to make room, and one that cannot load (a deleted GGUF) kept the server down
  // altogether while the image endpoint had everything it needed.
  it('keeps a resident image model and loads no chat model beside it', async () => {
    diffusion.emit({ type: 'state', status: makeLoadedStatus() })

    await pressStart()

    expect((await diffusion.getStatus()).model.state).toBe('loaded')
    expect(useLocalApiServer.getState().lastServerModels).toEqual([])
    expect(setRunning).toHaveBeenCalledWith(true)
  })

  // The embedding model answers /v1/embeddings by itself (an idle one starts on the request), and a
  // chat model loaded beside it could take the memory it runs in.
  it('loads no chat model while an embedding model is switched on', async () => {
    const embedding = {
      isSupported: () => true,
      getStatus: vi.fn(async () => ({ state: 'idle', enabled: true })),
    }
    initializeServiceHubStore(
      createMockServiceHub({
        app: { getServerStatus: vi.fn().mockResolvedValue(false) } as never,
        models: models as never,
        diffusion,
        embedding: embedding as never,
      })
    )

    await pressStart()

    expect(embedding.getStatus).toHaveBeenCalled()
    expect(useLocalApiServer.getState().lastServerModels).toEqual([])
    expect(setRunning).toHaveBeenCalledWith(true)
  })

  // Both providers own the id and TurboQuant is listed first, so "the first provider that has
  // it" named TurboQuant while the core ran the upstream build, and the Server card said
  // "llama.cpp turboquant".
  it('still loads the chat model first, and records the engine that runs it', async () => {
    await pressStart()

    expect(useLocalApiServer.getState().lastServerModels).toEqual([
      { model: 'gemma', provider: 'llamacpp-upstream' },
    ])
    expect(setRunning).toHaveBeenCalledWith(true)
  })

  it('records TurboQuant when that is the engine holding the session', async () => {
    ensureModel.mockImplementation(async () => {
      models.getActiveModels.mockImplementation(async (provider?: string) =>
        provider === undefined || provider === 'llamacpp' ? ['gemma'] : []
      )
      return { status: 'loaded', modelId: 'gemma', providerName: 'llamacpp' }
    })

    await pressStart()

    expect(useLocalApiServer.getState().lastServerModels).toEqual([
      { model: 'gemma', provider: 'llamacpp' },
    ])
  })
})

describe('stopping and starting the server with its models', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useAppState.setState({ serverStatus: 'stopped' })
    turnOff.mockResolvedValue(undefined)
    useLocalApiServer.getState().setServerPort(1337)
    bindsPort(1337)
    ensureModel.mockResolvedValue({ status: 'already_loaded' })
    initializeServiceHubStore(
      createMockServiceHub({
        app: { getServerStatus: vi.fn().mockResolvedValue(false) } as never,
        models: { getActiveModels: vi.fn(async () => []) } as never,
      })
    )
  })

  async function mount() {
    const { result } = renderHook(() => useLocalApiServerControl())
    await act(async () => {})
    return result
  }

  /** The server's status as the real calls leave it, which the panel reads. */
  const serverIs = (status: 'running' | 'stopped') =>
    useAppState.getState().setServerStatus(status)

  it('turns the server off together with the models it served', async () => {
    serverIs('running')
    turnOff.mockImplementation(async () => serverIs('stopped'))
    const control = await mount()

    await act(async () => {
      await control.current.stop()
    })

    expect(turnOff).toHaveBeenCalledTimes(1)
    expect(setRunning).not.toHaveBeenCalled()
    expect(control.current.isRunning).toBe(false)
  })

  it('keeps the models for a restart, which only brings the server back', async () => {
    serverIs('running')
    setRunning.mockImplementation(async (running: boolean) =>
      serverIs(running ? 'running' : 'stopped')
    )
    const control = await mount()

    await act(async () => {
      await control.current.stop({ keepModels: true })
    })

    expect(setRunning).toHaveBeenCalledWith(false)
    expect(turnOff).not.toHaveBeenCalled()
    expect(control.current.isRunning).toBe(false)
  })

  it('switches back on what the last turn-off switched off, once the server is up', async () => {
    const control = await mount()

    await act(async () => {
      await control.current.start()
    })

    expect(setRunning).toHaveBeenCalledWith(true)
    expect(resume).toHaveBeenCalledTimes(1)
    expect(setRunning.mock.invocationCallOrder[0]).toBeLessThan(
      resume.mock.invocationCallOrder[0]
    )
  })

  it('switches nothing back on when the server would not start', async () => {
    setRunning.mockImplementation(async () => {
      serverIs('stopped')
      throw new Error('Address already in use')
    })
    const control = await mount()

    await act(async () => {
      await control.current.start()
    })

    expect(resume).not.toHaveBeenCalled()
    // Start can be pressed again.
    expect(control.current.status).toBe('stopped')
    expect(control.current.isBusy).toBe(false)
  })
})
