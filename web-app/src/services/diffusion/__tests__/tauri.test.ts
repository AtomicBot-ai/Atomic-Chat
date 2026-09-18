import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

// The official IPC mock swallows `plugin:event|unlisten`, so the detach path
// can only be observed by stubbing the event module itself.
const listen = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

const { TauriDiffusionService, EVENT_MAP, RESET_EVENT } = await import('../tauri')
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

type Call = { method: string; path: string; body: unknown }

describe('TauriDiffusionService commands', () => {
  let calls: Call[]
  let service: InstanceType<typeof TauriDiffusionService>

  beforeEach(() => {
    calls = []
    mockIPC((command: string, args?: InvokeArgs) => {
      expect(command).toBe('atomic_core_call')
      const call = args as Call
      calls.push(call)
      const route = `${call.method} ${call.path.split('?')[0]}`
      switch (route) {
        case 'PUT /diffusion/config':
        case 'GET /diffusion/status':
        case 'PUT /diffusion/output-dir':
          return status
        case 'POST /diffusion/jobs':
          return { jobId: 'job-1' }
        case 'GET /diffusion/jobs/job-1':
          return { job: null }
        case 'POST /diffusion/jobs/job-1/cancel':
          return { cancelled: true, serverStopped: false }
        case 'GET /diffusion/backends':
          return { backends: [{ tag: 't', backendId: 'macos-arm64' }] }
        case 'GET /diffusion/model-files':
          return { files: [{ relativePath: 'z-image/x.gguf' }] }
        case 'GET /diffusion/gallery':
          return { items: [], hasMore: false, total: 0 }
        case 'GET /diffusion/gallery/job-1-00':
          return { item: { id: 'job-1-00' } }
        default:
          return {}
      }
    })
    service = new TauriDiffusionService()
  })

  it('is the supported implementation', () => {
    expect(service.isSupported()).toBe(true)
  })

  it('calls one core route per operation, with the interface parameters as the body', async () => {
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
    await service.listGallery({ offset: 60, limit: 60, includeArchived: true })
    await service.getGalleryItem('job-1-00')
    await service.deleteGalleryItems(['job-1-00', 'job-1-01'])
    await service.setGalleryFlags('job-1-00', { pinned: true })
    await service.exportGalleryItem('job-1-00', '/tmp/out.png')
    await service.setOutputDir('/elsewhere')

    expect(calls).toEqual([
      { method: 'PUT', path: '/diffusion/config', body: { dataFolder: '/data', idleUnloadSecs: 600 } },
      { method: 'GET', path: '/diffusion/status', body: null },
      {
        method: 'POST',
        path: '/diffusion/backends/finalize',
        body: {
          dir: '/data/diffusion/backends/t/macos-arm64',
          tag: 't',
          backendId: 'macos-arm64',
          backend: 'metal',
          engine: 'sd-cpp',
        },
      },
      { method: 'GET', path: '/diffusion/backends', body: null },
      { method: 'POST', path: '/diffusion/backends/remove', body: { dir: '/old' } },
      { method: 'GET', path: '/diffusion/model-files', body: null },
      {
        method: 'POST',
        path: '/diffusion/model-files/delete',
        body: { path: '/data/diffusion/models/z-image/x.gguf' },
      },
      { method: 'POST', path: '/diffusion/model/unload', body: null },
      { method: 'POST', path: '/diffusion/idle/touch', body: null },
      { method: 'GET', path: '/diffusion/jobs/job-1', body: null },
      { method: 'POST', path: '/diffusion/jobs/job-1/cancel', body: null },
      { method: 'GET', path: '/diffusion/gallery?offset=0&limit=60', body: null },
      { method: 'GET', path: '/diffusion/gallery?offset=60&limit=60&includeArchived=true', body: null },
      { method: 'GET', path: '/diffusion/gallery/job-1-00', body: null },
      { method: 'POST', path: '/diffusion/gallery/delete', body: { ids: ['job-1-00', 'job-1-01'] } },
      { method: 'PATCH', path: '/diffusion/gallery/job-1-00/flags', body: { pinned: true } },
      { method: 'POST', path: '/diffusion/gallery/job-1-00/export', body: { targetPath: '/tmp/out.png' } },
      { method: 'PUT', path: '/diffusion/output-dir', body: { path: '/elsewhere' } },
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
      { method: 'POST', path: '/diffusion/model/load', body: load },
      { method: 'POST', path: '/diffusion/jobs', body: generate },
      { method: 'GET', path: '/diffusion/capabilities', body: null },
    ])
  })

  it('returns what the core answers, unwrapping the four envelopes', async () => {
    await expect(service.getStatus()).resolves.toEqual(status)
    await expect(service.cancelJob('job-1')).resolves.toEqual({
      cancelled: true,
      serverStopped: false,
    })
    await expect(service.getJob('job-1')).resolves.toBeNull()
    await expect(service.listInstalledBackends()).resolves.toEqual([{ tag: 't', backendId: 'macos-arm64' }])
    await expect(service.listModelFiles()).resolves.toEqual([{ relativePath: 'z-image/x.gguf' }])
    await expect(service.getGalleryItem('job-1-00')).resolves.toEqual({ id: 'job-1-00' })
  })

  it('escapes ids in paths', async () => {
    await service.getJob('a/b c')
    expect(calls[0]?.path).toBe('/diffusion/jobs/a%2Fb%20c')
  })

  it('passes a core refusal through, so the banner can route on its code', async () => {
    mockIPC(() => {
      throw { code: 'JOB_BUSY', message: 'An image is already being generated.', details: 'job-1' }
    })
    await expect(service.generate({ prompt: 'x', width: 512, height: 512, steps: 4, cfgScale: 1, batchSize: 1 })).rejects.toEqual({
      code: 'JOB_BUSY',
      message: 'An image is already being generated.',
      details: 'job-1',
    })
  })
})

describe('TauriDiffusionService.subscribe', () => {
  beforeEach(() => {
    // A bare `listen.mockReset()` would return the mock, which Vitest runs as
    // a cleanup callback — and a pending `listen()` promise then hangs the hook.
    listen.mockReset()
  })

  it('listens on the four relayed core events and stamps the discriminant', async () => {
    const handlers = new Map<string, (event: { payload: unknown }) => void>()
    listen.mockImplementation(async (name: string, handler: (event: { payload: unknown }) => void) => {
      handlers.set(name, handler)
      return () => {}
    })
    const received: DiffusionEvent[] = []
    new TauriDiffusionService().subscribe((event) => received.push(event))
    await Promise.resolve()

    expect([...handlers.keys()]).toEqual([...Object.keys(EVENT_MAP), RESET_EVENT])
    handlers.get('atomic-core://diffusion:progress')!({
      payload: { jobId: 'job-1', progress: { phase: 'sampling', step: 3, totalSteps: 8 } },
    })
    handlers.get('atomic-core://diffusion:error')!({
      payload: { code: 'OUT_OF_MEMORY', message: 'boom' },
    })
    // A new core generation attached: the store has to configure it again.
    handlers.get(RESET_EVENT)!({ payload: { generation: 3, snapshot: {} } })
    handlers.get(RESET_EVENT)!({ payload: {} })
    expect(received).toEqual([
      {
        type: 'progress',
        jobId: 'job-1',
        progress: { phase: 'sampling', step: 3, totalSteps: 8 },
      },
      { type: 'error', code: 'OUT_OF_MEMORY', message: 'boom' },
      { type: 'reset', generation: 3 },
      { type: 'reset', generation: null },
    ])
  })

  it('detaches each listener once, even when unsubscribed twice', async () => {
    const unlistens = [...Object.keys(EVENT_MAP), RESET_EVENT].map(() => vi.fn())
    let index = 0
    listen.mockImplementation(async () => unlistens[index++])

    const unsubscribe = new TauriDiffusionService().subscribe(() => {})
    expect(unsubscribe()).toBeUndefined()
    expect(unsubscribe()).toBeUndefined()
    await new Promise((resolve) => setTimeout(resolve, 0))

    expect(unlistens.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
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

    expect(unlistens.map((fn) => fn.mock.calls.length)).toEqual([1, 1, 1, 1, 1])
  })
})
