import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

// The official IPC mock swallows `plugin:event|unlisten`, so the detach path
// can only be observed by stubbing the event module itself.
const listen = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

const { TauriDiffusionService, EVENT_MAP, PLUGIN } = await import('../tauri')
type DiffusionEvent = import('../types').DiffusionEvent
type DiffusionStatus = import('../types').DiffusionStatus

const status: DiffusionStatus = {
  configured: true,
  install: { state: 'not-installed' },
  model: { state: 'unloaded', loaded: null },
  activeJob: null,
  outputDir: '/data/images',
  idleUnloadSecs: 600,
}

describe('TauriDiffusionService commands', () => {
  let calls: Array<[string, InvokeArgs | undefined]>
  let service: InstanceType<typeof TauriDiffusionService>

  beforeEach(() => {
    calls = []
    mockIPC((command: string, args?: InvokeArgs) => {
      calls.push([command, args])
      switch (command) {
        case `${PLUGIN}|configure`:
        case `${PLUGIN}|get_status`:
        case `${PLUGIN}|set_output_dir`:
          return status
        case `${PLUGIN}|generate`:
          return { jobId: 'job-1' }
        case `${PLUGIN}|get_job`:
          return null
        case `${PLUGIN}|cancel_job`:
          return { cancelled: true, serverStopped: false }
        case `${PLUGIN}|list_installed_backends`:
        case `${PLUGIN}|list_model_files`:
          return []
        case `${PLUGIN}|list_gallery`:
          return { items: [], hasMore: false, total: 0 }
        default:
          return undefined
      }
    })
    service = new TauriDiffusionService()
  })

  it('is the supported implementation', () => {
    expect(service.isSupported()).toBe(true)
  })

  it('names every command in snake_case with the interface parameters as args', async () => {
    await service.configure({ dataFolder: '/data', idleUnloadSecs: 600 })
    await service.getStatus()
    await service.finalizeBackendInstall({
      dir: '/data/diffusion/backends/t/macos-arm64',
      tag: 't',
      backendId: 'macos-arm64',
      backend: 'metal',
      engine: 'sd-cpp',
    })
    await service.listInstalledBackends()
    await service.removeBackend('/old')
    await service.listModelFiles()
    await service.deleteModelFile('/data/diffusion/models/z-image/x.gguf')
    await service.unloadModel()
    await service.touchIdle()
    await service.getJob('job-1')
    await service.cancelJob('job-1')
    await service.listGallery({ offset: 0, limit: 60 })
    await service.getGalleryItem('job-1-00')
    await service.deleteGalleryItems(['job-1-00', 'job-1-01'])
    await service.setGalleryFlags('job-1-00', { pinned: true })
    await service.exportGalleryItem('job-1-00', '/tmp/out.png')
    await service.setOutputDir('/elsewhere')

    expect(calls).toEqual([
      [`${PLUGIN}|configure`, { config: { dataFolder: '/data', idleUnloadSecs: 600 } }],
      [`${PLUGIN}|get_status`, {}],
      [
        `${PLUGIN}|finalize_backend_install`,
        {
          args: {
            dir: '/data/diffusion/backends/t/macos-arm64',
            tag: 't',
            backendId: 'macos-arm64',
            backend: 'metal',
            engine: 'sd-cpp',
          },
        },
      ],
      [`${PLUGIN}|list_installed_backends`, {}],
      [`${PLUGIN}|remove_backend`, { dir: '/old' }],
      [`${PLUGIN}|list_model_files`, {}],
      [`${PLUGIN}|delete_model_file`, { path: '/data/diffusion/models/z-image/x.gguf' }],
      [`${PLUGIN}|unload_model`, {}],
      [`${PLUGIN}|touch_idle`, {}],
      [`${PLUGIN}|get_job`, { jobId: 'job-1' }],
      [`${PLUGIN}|cancel_job`, { jobId: 'job-1' }],
      [`${PLUGIN}|list_gallery`, { options: { offset: 0, limit: 60 } }],
      [`${PLUGIN}|get_gallery_item`, { id: 'job-1-00' }],
      [`${PLUGIN}|delete_gallery_items`, { ids: ['job-1-00', 'job-1-01'] }],
      [`${PLUGIN}|set_gallery_flags`, { id: 'job-1-00', flags: { pinned: true } }],
      [`${PLUGIN}|export_gallery_item`, { id: 'job-1-00', targetPath: '/tmp/out.png' }],
      [`${PLUGIN}|set_output_dir`, { path: '/elsewhere' }],
    ])
  })

  it('passes the load and generate requests through unchanged', async () => {
    const load = {
      modelId: 'z-image:q4_k_m',
      family: 'z-image' as const,
      modality: 'image' as const,
      displayName: 'Z-Image Turbo Q4_K_M',
      files: { diffusionModel: '/m.gguf', vae: '/ae.safetensors', llm: '/qwen.safetensors' },
      defaults: { steps: 8, cfgScale: 1, width: 1024, height: 1024 },
      ranges: { steps: [1, 50] as [number, number], dims: [256, 2048] as [number, number], dimMultiple: 16 },
      offload: 'group' as const,
    }
    await service.loadModel(load)
    const generate = {
      prompt: 'a cat',
      width: 1024,
      height: 1024,
      steps: 8,
      cfgScale: 1,
      batchSize: 2,
      seed: 42,
    }
    await expect(service.generate(generate)).resolves.toEqual({ jobId: 'job-1' })
    await service.getCapabilities()

    expect(calls).toEqual([
      [`${PLUGIN}|load_model`, { request: load }],
      [`${PLUGIN}|generate`, { request: generate }],
      [`${PLUGIN}|get_capabilities`, {}],
    ])
  })

  it('returns what the plugin answers', async () => {
    await expect(service.getStatus()).resolves.toEqual(status)
    await expect(service.cancelJob('job-1')).resolves.toEqual({
      cancelled: true,
      serverStopped: false,
    })
    await expect(service.getJob('missing')).resolves.toBeNull()
  })
})

describe('TauriDiffusionService.subscribe', () => {
  beforeEach(() => {
    // A bare `listen.mockReset()` would return the mock, which Vitest runs as
    // a cleanup callback — and a pending `listen()` promise then hangs the hook.
    listen.mockReset()
  })

  it('listens on the four plugin events and stamps the discriminant', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler)
      return () => {}
    })
    const received: DiffusionEvent[] = []
    new TauriDiffusionService().subscribe((event) => received.push(event))
    await Promise.resolve()

    expect([...handlers.keys()]).toEqual(Object.keys(EVENT_MAP))
    handlers.get('atomic-diffusion://progress')!({
      payload: { jobId: 'job-1', progress: { phase: 'sampling', step: 3, totalSteps: 8 } },
    })
    handlers.get('atomic-diffusion://error')!({
      payload: { code: 'OUT_OF_MEMORY', message: 'boom' },
    })
    expect(received).toEqual([
      {
        type: 'progress',
        jobId: 'job-1',
        progress: { phase: 'sampling', step: 3, totalSteps: 8 },
      },
      { type: 'error', code: 'OUT_OF_MEMORY', message: 'boom' },
    ])
  })

  it('detaches each listener once, even when unsubscribed twice', async () => {
    const unlistens = Object.keys(EVENT_MAP).map(() => vi.fn())
    let index = 0
    listen.mockImplementation(async () => unlistens[index++])

    const unsubscribe = new TauriDiffusionService().subscribe(() => {})
    expect(unsubscribe()).toBeUndefined()
    expect(unsubscribe()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unlistens.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1])
  })

  it('still detaches listeners whose registration finishes after unsubscribe', async () => {
    const resolvers: Array<(fn: () => void) => void> = []
    listen.mockImplementation(
      () =>
        new Promise<() => void>((resolve) => {
          resolvers.push(resolve)
        })
    )

    const unsubscribe = new TauriDiffusionService().subscribe(() => {})
    unsubscribe()
    const unlistens = resolvers.map(() => vi.fn())
    resolvers.forEach((resolve, i) => resolve(unlistens[i]))
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unlistens.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1])
  })
})
