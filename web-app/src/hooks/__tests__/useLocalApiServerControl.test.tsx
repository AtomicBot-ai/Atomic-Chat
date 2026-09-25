import { act, renderHook, waitFor } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

import { useLocalApiServer } from '@/hooks/useLocalApiServer'
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
  findProvider,
} = vi.hoisted(() => ({
  toastInfo: vi.fn(),
  toastWarning: vi.fn(),
  toastError: vi.fn(),
  toastDismiss: vi.fn(),
  setRunning: vi.fn(),
  ensureModel: vi.fn(),
  findProvider: vi.fn(),
}))

vi.mock('sonner', () => ({
  toast: { info: toastInfo, warning: toastWarning, error: toastError, dismiss: toastDismiss },
}))
vi.mock('@/utils/localApiServerControl', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/utils/localApiServerControl')>()),
  setLocalApiServerRunning: setRunning,
  stopLocalApiServer: vi.fn(),
}))
vi.mock('@/utils/ensureModelForServer', () => ({
  ensureModelForServer: ensureModel,
  findProviderForModel: findProvider,
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
    const [title, options] = toastWarning.mock.calls[0] as [string, { description: string }]
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

describe('what Start loads before the server comes up', () => {
  const models = {
    getActiveModels: vi.fn(async () => [] as string[]),
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
    // Loading the chat model does what it does on a machine that cannot hold both: the GPU
    // arbiter unloads the image model to make room.
    ensureModel.mockImplementation(async () => {
      diffusion.emit({ type: 'state', status: makeStatus() })
      models.getActiveModels.mockResolvedValue(['gemma'])
      return { status: 'loaded', modelId: 'gemma', providerName: 'llamacpp' }
    })
    findProvider.mockReturnValue({ provider: 'llamacpp' })
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

  it('still loads the chat model first when nothing else is resident', async () => {
    await pressStart()

    expect(useLocalApiServer.getState().lastServerModels).toEqual([
      { model: 'gemma', provider: 'llamacpp' },
    ])
    expect(setRunning).toHaveBeenCalledWith(true)
  })
})
