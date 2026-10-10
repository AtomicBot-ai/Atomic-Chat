import { AppEvent, events } from '@janhq/core'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

// A minimal in-process bus: the app's listeners hear `@janhq/core` events
// through the webview's `core.events`, which the suite does not set up.
vi.mock('@janhq/core', () => {
  const handlers = new Map<string, Set<(payload: unknown) => void>>()
  return {
    events: {
      on: (name: string, handler: (payload: unknown) => void) => {
        if (!handlers.has(name)) handlers.set(name, new Set())
        handlers.get(name)!.add(handler)
      },
      off: (name: string, handler: (payload: unknown) => void) => {
        handlers.get(name)?.delete(handler)
      },
      emit: (name: string, payload?: unknown) => {
        handlers.get(name)?.forEach((handler) => handler(payload))
      },
    },
    AppEvent: {
      onBackendDownloadStarted: 'onBackendDownloadStarted',
      onBackendDownloadFinished: 'onBackendDownloadFinished',
    },
    DownloadEvent: {},
  }
})

// The relay's progress frames, by event name, for the core's answer to send.
const relayed = new Map<string, (event: { payload: unknown }) => void>()
vi.mock('@tauri-apps/api/event', () => ({
  listen: async (name: string, handler: (event: { payload: unknown }) => void) => {
    relayed.set(name, handler)
    return () => relayed.delete(name)
  },
}))
/** The core downloads under `taskId` and then answers `result`. */
const downloadsThen =
  (result: unknown) =>
  async (_engine: string, request: { task_id: string }) => {
    relayed.get(`download-${request.task_id}`)?.({
      payload: { transferred: 5, total: 10 },
    })
    return result
  }

const core = vi.hoisted(() => ({
  updateEngine: vi.fn(),
  activateEngineBuild: vi.fn(),
}))
vi.mock('../core', () => core)

const {
  activateEngineBuildThroughCore,
  engineUpdateTaskId,
  switchBackendThroughCore,
  updateEngineWithProgress,
} = await import('../update')

const UPDATED = {
  updated: true,
  active: { version: 'b11500', variant: 'macos-arm64' },
  retired: [{ version: 'b11400', variant: 'macos-arm64' }],
  kept_in_use: [],
}

/** Everything the app hears, in order: backend events and the hot-swap. */
function record() {
  const heard: string[] = []
  const started = (p: { backend: string; provider: string }) =>
    heard.push(`started ${p.provider} ${p.backend}`)
  const finished = (p: { backend: string; provider: string; status: string }) =>
    heard.push(`finished ${p.provider} ${p.backend} ${p.status}`)
  const hotswapped = (e: Event) => {
    const d = (e as CustomEvent<{ provider: string; backend: string }>).detail
    heard.push(`hotswapped ${d.provider} ${d.backend}`)
  }
  events.on(AppEvent.onBackendDownloadStarted, started)
  events.on(AppEvent.onBackendDownloadFinished, finished)
  window.addEventListener('app:backend-hotswapped', hotswapped)
  return {
    heard,
    stop: () => {
      events.off(AppEvent.onBackendDownloadStarted, started)
      events.off(AppEvent.onBackendDownloadFinished, finished)
      window.removeEventListener('app:backend-hotswapped', hotswapped)
    },
  }
}

describe('engine updates through the core', () => {
  let recorder: ReturnType<typeof record>

  beforeEach(() => {
    vi.clearAllMocks()
    relayed.clear()
    localStorage.clear()
    recorder = record()
  })
  afterEach(() => recorder.stop())

  it('names the task after the engine and the version, in Tauri’s event alphabet', () => {
    expect(engineUpdateTaskId('llamacpp', 'b9100-1.7.0')).toBe(
      'engine-update-llamacpp-b9100-1_7_0'
    )
  })

  it('tells the backend dialog a llama.cpp download started, finished, then that the provider switched', async () => {
    core.updateEngine.mockImplementation(downloadsThen(UPDATED))

    await updateEngineWithProgress('llamacpp-upstream', {
      taskId: 'engine-update-llamacpp-upstream-b11500',
      target: { version: 'b11500', variant: 'macos-arm64' },
    })

    expect(core.updateEngine).toHaveBeenCalledWith('llamacpp-upstream', {
      task_id: 'engine-update-llamacpp-upstream-b11500',
      target: { version: 'b11500', variant: 'macos-arm64' },
      app_version: 'test',
    })
    // The finish comes first: the dialog arms its "restart required" fallback
    // on it, and the hot-swap right after closes that.
    expect(recorder.heard).toEqual([
      'started llamacpp-upstream b11500/macos-arm64',
      'finished llamacpp-upstream b11500/macos-arm64 completed',
      'hotswapped llamacpp-upstream b11500/macos-arm64',
    ])
  })

  it('says the download failed and switches nothing when the core refuses', async () => {
    core.updateEngine.mockImplementation(async (_engine: string, request: { task_id: string }) => {
      relayed.get(`download-${request.task_id}`)?.({ payload: { transferred: 1, total: 10 } })
      throw { code: 'ENGINE_INSTALL_FAILED', message: 'download failed' }
    })

    await expect(
      updateEngineWithProgress('llamacpp', {
        taskId: 't',
        target: { version: 'b9100-1.7.0', variant: 'win-cuda-12-x64' },
      })
    ).rejects.toMatchObject({ code: 'ENGINE_INSTALL_FAILED' })

    expect(recorder.heard).toEqual([
      'started llamacpp b9100-1.7.0/win-cuda-12-x64',
      'finished llamacpp b9100-1.7.0/win-cuda-12-x64 failed',
    ])
  })

  it('only reports the switch when the build was already on disk', async () => {
    core.updateEngine.mockResolvedValue(UPDATED)

    await updateEngineWithProgress('llamacpp-upstream', {
      taskId: 't',
      target: { version: 'b11500', variant: 'macos-arm64' },
    })

    expect(recorder.heard).toEqual(['hotswapped llamacpp-upstream b11500/macos-arm64'])
  })

  it('reports nothing when the core changed nothing', async () => {
    core.updateEngine.mockResolvedValue({
      ...UPDATED,
      updated: false,
      reason: 'no-update',
      retired: [],
    })

    const result = await updateEngineWithProgress('llamacpp-upstream', { taskId: 't' })

    expect(result.updated).toBe(false)
    expect(recorder.heard).toEqual([])
  })

  it('drops the provider’s persisted backend recommendation once the core switched', async () => {
    localStorage.setItem('turboquant_better_backend_recommendation', '{}')
    localStorage.setItem('llama_cpp_better_backend_recommendation', '{}')
    core.updateEngine.mockResolvedValue({
      ...UPDATED,
      active: { version: 'b10269-1.4.0', variant: 'windows-x64-cuda-13.3' },
    })

    await updateEngineWithProgress('llamacpp', { taskId: 't' })

    expect(localStorage.getItem('turboquant_better_backend_recommendation')).toBeNull()
    expect(localStorage.getItem('llama_cpp_better_backend_recommendation')).toBe('{}')
  })

  it('sends no llama.cpp events for MLX or sd.cpp', async () => {
    core.updateEngine.mockResolvedValue({
      ...UPDATED,
      active: { version: 'mlxvlm-macos-arm64-abc1234', variant: 'macos-arm64' },
    })
    await updateEngineWithProgress('mlx', { taskId: 't' })
    expect(recorder.heard).toEqual([])
  })

  it('switches to the newest build of a variant for a `latest/<variant>` pick, keyed on the pick', async () => {
    core.updateEngine.mockImplementation(
      downloadsThen({
        ...UPDATED,
        active: { version: 'b11500', variant: 'win-vulkan-x64' },
      })
    )

    const result = await switchBackendThroughCore(
      'llamacpp-upstream',
      'latest/win-vulkan-x64'
    )

    expect(result.active).toEqual({
      version: 'b11500',
      variant: 'win-vulkan-x64',
    })
    expect(core.updateEngine).toHaveBeenCalledWith('llamacpp-upstream', {
      task_id: 'engine-update-llamacpp-upstream-latest-win-vulkan-x64',
      target: { variant: 'win-vulkan-x64' },
      app_version: 'test',
    })
    // The dialog opened on the pick, so its events carry the pick.
    expect(recorder.heard).toEqual([
      'started llamacpp-upstream latest/win-vulkan-x64',
      'finished llamacpp-upstream latest/win-vulkan-x64 completed',
      'hotswapped llamacpp-upstream b11500/win-vulkan-x64',
    ])
  })

  it('switches to a concrete pick with its version', async () => {
    core.updateEngine.mockResolvedValue({
      ...UPDATED,
      active: { version: 'prism-b9100-1234567', variant: 'macos-arm64' },
    })
    const result = await switchBackendThroughCore(
      'atomic-prism',
      'prism-b9100-1234567/macos-arm64'
    )
    expect(result.active?.version).toBe('prism-b9100-1234567')
    expect(core.updateEngine).toHaveBeenCalledWith('atomic-prism', {
      task_id: 'engine-update-atomic-prism-prism-b9100-1234567',
      target: { version: 'prism-b9100-1234567', variant: 'macos-arm64' },
      app_version: 'test',
    })
  })

  it('refuses a malformed pick before asking the core', async () => {
    await expect(
      switchBackendThroughCore('llamacpp', 'nonsense')
    ).rejects.toThrow()
    expect(core.updateEngine).not.toHaveBeenCalled()
  })

  it('announces an activation the core made, and nothing for one already active', async () => {
    core.activateEngineBuild.mockResolvedValueOnce({
      activated: true,
      active: { version: 'b11400', variant: 'win-vulkan-x64' },
    })
    await activateEngineBuildThroughCore(
      'llamacpp-upstream',
      'b11400',
      'win-vulkan-x64'
    )
    core.activateEngineBuild.mockResolvedValueOnce({
      activated: false,
      reason: 'already-active',
      active: { version: 'b11400', variant: 'win-vulkan-x64' },
    })
    await activateEngineBuildThroughCore(
      'llamacpp-upstream',
      'b11400',
      'win-vulkan-x64'
    )

    expect(recorder.heard).toEqual([
      'hotswapped llamacpp-upstream b11400/win-vulkan-x64',
    ])
  })
})
