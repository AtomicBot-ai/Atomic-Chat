import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

import {
  makeCapabilities,
  makeCatalog,
  makeFakeDiffusion,
  makeItem,
  makeJob,
  makeLoadedStatus,
  makeRequest,
  makeStatus,
  MODELS_ROOT,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import { seedServiceHub } from '@/test/service-hub'
import { useImageSetting } from '@/hooks/useImageSetting'

// The store talks to the plugin through the hub (faked below) and to the
// catalog, config, arbiter and install modules — each of which has its own
// tests; here they are the environment, not the subject.
vi.mock('@/services/diffusion-catalog-registry', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/services/diffusion-catalog-registry')>()),
  fetchDiffusionCatalog: vi.fn(async () => ({
    catalog: makeCatalog(),
    source: 'baseline' as const,
    fetchedAt: null,
  })),
}))
vi.mock('@/lib/diffusion/config', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/diffusion/config')>()),
  configureDiffusion: vi.fn(async () => makeStatus()),
  getDiffusionPaths: vi.fn(async () => ({
    dataFolder: '/data',
    modelsRoot: MODELS_ROOT,
    backendsRoot: '/data/diffusion/backends',
    imagesDir: '/data/images',
  })),
}))
vi.mock('@/lib/diffusion/arbiter', () => ({
  acquireGpuForDiffusion: vi.fn(async () => ({ evicted: [] })),
}))
const install = vi.hoisted(() => ({
  ensure: vi.fn(),
  select: vi.fn(async () => ({ backendId: 'macos-arm64' as string | null, reason: undefined as string | undefined })),
}))
vi.mock('@/services/diffusion/install', () => ({
  ensureDiffusionBackend: install.ensure,
  selectDiffusionBackendForHost: install.select,
}))
vi.mock('@/lib/notifications', () => ({ notifyThreadCompleted: vi.fn() }))
const captured = vi.hoisted(() => ({ events: [] as Array<[string, Record<string, unknown>]> }))
vi.mock('@/lib/telemetry-queue', () => ({
  queuedCapture: vi.fn((event: string, props: Record<string, unknown>) => {
    captured.events.push([event, props])
  }),
}))

import { useImageGalleryStore } from '../image-gallery-store'
import {
  resetImageGenerationForTests,
  useImageGenerationStore,
} from '../image-generation-store'

/** Emit after the loop has registered its waiter (a macrotask later). */
const emitLater = (fake: FakeDiffusion, jobs: () => Parameters<FakeDiffusion['emit']>[0]) =>
  setTimeout(() => fake.emit(jobs()), 0)

describe('image-generation-store', () => {
  let fake: FakeDiffusion

  beforeEach(async () => {
    vi.useRealTimers()
    captured.events.length = 0
    install.ensure.mockReset()
    install.select.mockResolvedValue({ backendId: 'macos-arm64', reason: undefined })
    useImageSetting.setState({ selectedArtifactId: null, keepModelLoaded: false, idleUnloadMinutes: 10 })
    resetImageGenerationForTests()
    useImageGalleryStore.getState().reset()
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
    // The production path: subscribe, read the status, load the catalog.
    await useImageGenerationStore.getState().bind()
    useImageGenerationStore.setState({
      status: makeLoadedStatus(),
      capabilities: makeCapabilities(),
    })
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('run loop', () => {
    it('advances the seed by the batch size per run and prepends every batch', async () => {
      let n = 0
      fake.generate.mockImplementation(async (request) => {
        const id = `job-${++n}`
        emitLater(fake, () => ({
          type: 'job',
          job: makeJob({
            id,
            state: 'completed',
            request,
            outputs: [makeItem({ id: `${id}-00` }), makeItem({ id: `${id}-01` })],
          }),
        }))
        return { jobId: id }
      })

      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest({ batchSize: 2 }),
        runs: 3,
        baseSeed: 100,
      })

      expect(fake.generate.mock.calls.map(([request]) => request.seed)).toEqual([
        100, 102, 104,
      ])
      // Newest batch first, its images in order.
      expect(useImageGalleryStore.getState().items.map((item) => item.id)).toEqual([
        'job-3-00',
        'job-3-01',
        'job-2-00',
        'job-2-01',
        'job-1-00',
        'job-1-01',
      ])
      expect(useImageGalleryStore.getState().selectedId).toBe('job-3-00')
      const state = useImageGenerationStore.getState()
      expect(state.runsDone).toBe(3)
      expect(state.generating).toBe(false)
      expect(state.currentJob).toBeNull()
      expect(state.lastError).toBeNull()
    })

    it('lets the engine draw the seed when none is set', async () => {
      fake.generate.mockImplementation(async (request) => {
        emitLater(fake, () => ({
          type: 'job',
          job: makeJob({ id: 'job-1', state: 'completed', request }),
        }))
        return { jobId: 'job-1' }
      })
      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      expect(fake.generate.mock.calls[0][0].seed).toBeUndefined()
    })

    it('stops after the running job when the user presses Stop, without an error', async () => {
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 3,
        baseSeed: 5,
      })
      await waitFor(() => expect(fake.generate).toHaveBeenCalledTimes(1))

      await useImageGenerationStore.getState().stop()
      expect(fake.cancelJob).toHaveBeenCalledWith('job-1')
      // The renderer reports the cancellation the way sd-server does — after
      // the process has been killed.
      fake.emit({
        type: 'job',
        job: makeJob({
          id: 'job-1',
          state: 'cancelled',
          error: { code: 'CANCELLED', message: 'stopped' },
        }),
      })
      await done

      const state = useImageGenerationStore.getState()
      expect(fake.generate).toHaveBeenCalledTimes(1)
      expect(state.generating).toBe(false)
      expect(state.stopRequested).toBe(true)
      expect(state.lastError).toBeNull()
      expect(useImageGalleryStore.getState().items).toHaveLength(0)
    })

    it('surfaces a failure and abandons the remaining runs', async () => {
      fake.generate.mockImplementation(async () => {
        emitLater(fake, () => ({
          type: 'job',
          job: makeJob({
            id: 'job-1',
            state: 'failed',
            error: { code: 'OUT_OF_MEMORY', message: 'ggml alloc failed' },
          }),
        }))
        return { jobId: 'job-1' }
      })
      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 3,
        baseSeed: null,
      })
      const state = useImageGenerationStore.getState()
      expect(fake.generate).toHaveBeenCalledTimes(1)
      expect(state.lastError?.code).toBe('OUT_OF_MEMORY')
      expect(state.generating).toBe(false)
      expect(captured.events.map(([name, props]) => [name, props.generate_status, props.error_code])).toEqual([
        ['image_generate', 'failed', 'OUT_OF_MEMORY'],
      ])
    })

    it('reports each run without the prompt or the seed', async () => {
      fake.generate.mockImplementation(async (request) => {
        emitLater(fake, () => ({
          type: 'job',
          job: makeJob({ id: 'job-1', state: 'completed', request }),
        }))
        return { jobId: 'job-1' }
      })
      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest({ prompt: 'secret garden', width: 768, height: 512 }),
        runs: 1,
        baseSeed: 1234,
      })
      const [name, props] = captured.events[0]
      expect(name).toBe('image_generate')
      expect(props).toMatchObject({
        generate_status: 'completed',
        model_family: 'z-image',
        quant: 'q4_k_m',
        width: 768,
        height: 512,
        runs: 1,
      })
      expect(JSON.stringify(props)).not.toContain('secret garden')
      expect(JSON.stringify(props)).not.toContain('1234')
    })

    it('refuses a request the loaded model cannot take before touching the plugin', async () => {
      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest({ width: 1000 }),
        runs: 1,
        baseSeed: null,
      })
      expect(fake.generate).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'INVALID_DIMENSIONS'
      )
    })

    it('falls back to polling when the terminal event never arrives', async () => {
      vi.useFakeTimers()
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      fake.getJob.mockResolvedValue(
        makeJob({ id: 'job-1', state: 'completed', outputs: [makeItem({ id: 'job-1-00' })] })
      )
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await vi.advanceTimersByTimeAsync(2_100)
      await done
      expect(useImageGalleryStore.getState().items.map((item) => item.id)).toEqual([
        'job-1-00',
      ])
      expect(useImageGenerationStore.getState().generating).toBe(false)
    })

    it('tracks progress events for the job in flight', async () => {
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await waitFor(() =>
        expect(useImageGenerationStore.getState().currentJob?.id).toBe('job-1')
      )
      fake.emit({
        type: 'progress',
        jobId: 'job-1',
        progress: {
          phase: 'sampling',
          step: 3,
          totalSteps: 8,
          fraction: 0.4,
          etaSeconds: 6,
          batchIndex: 0,
          batchSize: 1,
          elapsedMs: 2000,
        },
      })
      expect(useImageGenerationStore.getState().currentJob).toMatchObject({
        state: 'generating',
        progress: { step: 3, totalSteps: 8 },
      })
      fake.emit({ type: 'job', job: makeJob({ id: 'job-1', state: 'completed' }) })
      await done
    })
  })

  describe('bind', () => {
    it('adopts a job that was already running and lands its outputs', async () => {
      resetImageGenerationForTests()
      fake.getStatus.mockResolvedValue({
        ...makeLoadedStatus(),
        activeJob: makeJob({ id: 'job-a', state: 'generating' }),
      })
      await useImageGenerationStore.getState().bind()

      let state = useImageGenerationStore.getState()
      expect(state.currentJob?.id).toBe('job-a')
      expect(state.generating).toBe(true)
      expect(state.catalog?.families[0].id).toBe('z-image')

      fake.emit({
        type: 'job',
        job: makeJob({
          id: 'job-a',
          state: 'completed',
          outputs: [makeItem({ id: 'job-a-00' })],
        }),
      })
      await waitFor(() =>
        expect(useImageGenerationStore.getState().generating).toBe(false)
      )
      state = useImageGenerationStore.getState()
      expect(state.runsDone).toBe(1)
      expect(useImageGalleryStore.getState().items[0]?.id).toBe('job-a-00')
    })

    it('reads the capabilities of a model that is already resident', async () => {
      resetImageGenerationForTests()
      fake.getStatus.mockResolvedValue(makeLoadedStatus())
      await useImageGenerationStore.getState().bind()
      expect(useImageGenerationStore.getState().capabilities?.maxBatch).toBe(4)
    })

    it('drops the capabilities when the plugin reports the model gone', async () => {
      fake.emit({ type: 'state', status: makeStatus(), reason: 'idle' })
      expect(useImageGenerationStore.getState().capabilities).toBeNull()
      expect(useImageGenerationStore.getState().status?.model.state).toBe('unloaded')
    })
  })

  describe('loadModel', () => {
    it('hands the plugin the resolved files and reads the capabilities back', async () => {
      useImageGenerationStore.setState({ status: makeStatus(), capabilities: null })

      await useImageGenerationStore.getState().loadModel('z-image:q4_k_m')

      const request = fake.loadModel.mock.calls[0][0]
      expect(request).toMatchObject({
        modelId: 'z-image:q4_k_m',
        family: 'z-image',
        modality: 'image',
      })
      expect(request.files.diffusionModel).toContain('z-image-turbo-Q4_K_M.gguf')
      expect(request.files.llm).toContain('Qwen3-4B-Q4_K_M.gguf')
      const state = useImageGenerationStore.getState()
      expect(state.capabilities?.maxBatch).toBe(4)
      expect(state.status?.model.loaded?.modelId).toBe('z-image:q4_k_m')
      expect(state.loadingArtifactId).toBeNull()
      expect(state.lastError).toBeNull()
    })

    it('reports an unknown artifact as a missing model', async () => {
      await useImageGenerationStore.getState().loadModel('z-image:nope')
      expect(fake.loadModel).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().lastError?.code).toBe('MODEL_MISSING')
    })

    it('keeps a plugin refusal as the last error', async () => {
      fake.loadModel.mockRejectedValue({ code: 'OUT_OF_MEMORY', message: 'no vram' })
      await useImageGenerationStore.getState().loadModel('z-image:q8_0')
      expect(useImageGenerationStore.getState().lastError).toMatchObject({
        code: 'OUT_OF_MEMORY',
      })
      expect(useImageGenerationStore.getState().loadingArtifactId).toBeNull()
    })
  })

  describe('run loop edge cases', () => {
    it('ignores a second Generate while one batch is running', async () => {
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      const first = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await waitFor(() => expect(fake.generate).toHaveBeenCalledTimes(1))
      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      expect(fake.generate).toHaveBeenCalledTimes(1)
      expect(useImageGenerationStore.getState().generating).toBe(true)
      fake.emit({ type: 'job', job: makeJob({ id: 'job-1', state: 'completed' }) })
      await first
      expect(useImageGenerationStore.getState().generating).toBe(false)
    })

    it('reports a refused submit as the last error and stops', async () => {
      fake.generate.mockRejectedValue({ code: 'JOB_BUSY', message: 'busy' })
      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 2,
        baseSeed: null,
      })
      const state = useImageGenerationStore.getState()
      expect(state.lastError?.code).toBe('JOB_BUSY')
      expect(state.generating).toBe(false)
      expect(fake.generate).toHaveBeenCalledTimes(1)
    })

    it('marks a job the plugin has forgotten as failed', async () => {
      vi.useFakeTimers()
      fake.generate.mockImplementation(async () => ({ jobId: 'job-x' }))
      fake.getJob.mockResolvedValue(null)
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await vi.advanceTimersByTimeAsync(2_100)
      await done
      expect(useImageGenerationStore.getState().lastError?.code).toBe('JOB_NOT_FOUND')
    })

    it('surfaces an error event for the running job, but not a cancel the user asked for', async () => {
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await waitFor(() =>
        expect(useImageGenerationStore.getState().currentJob?.id).toBe('job-1')
      )
      fake.emit({ type: 'error', jobId: 'other', code: 'INTERNAL', message: 'elsewhere' })
      expect(useImageGenerationStore.getState().lastError).toBeNull()

      fake.emit({ type: 'error', jobId: 'job-1', code: 'ENGINE_CRASHED', message: 'sd-server died' })
      expect(useImageGenerationStore.getState().lastError?.code).toBe('ENGINE_CRASHED')

      useImageGenerationStore.setState({ lastError: null, stopRequested: true })
      fake.emit({ type: 'error', jobId: 'job-1', code: 'CANCELLED', message: 'stopped' })
      expect(useImageGenerationStore.getState().lastError).toBeNull()

      fake.emit({ type: 'job', job: makeJob({ id: 'job-1', state: 'cancelled' }) })
      await done
    })

    it('Stop with nothing running only records the intent', async () => {
      await useImageGenerationStore.getState().stop()
      expect(fake.cancelJob).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().stopRequested).toBe(true)
    })

    it('a state event carrying a model error surfaces it when idle', () => {
      fake.emit({
        type: 'state',
        status: makeStatus({
          model: {
            state: 'failed',
            loaded: null,
            error: { code: 'MODEL_LOAD_FAILED', message: 'bad gguf' },
          },
        }),
      })
      expect(useImageGenerationStore.getState().lastError?.code).toBe('MODEL_LOAD_FAILED')
      useImageGenerationStore.getState().clearError()
      expect(useImageGenerationStore.getState().lastError).toBeNull()
    })
  })

  describe('engine install', () => {
    it('tracks progress, then reads the installed status and reports the backend', async () => {
      install.ensure.mockImplementation(async ({ onProgress }) => {
        onProgress?.({ transferred: 50, total: 100 })
        fake.getStatus.mockResolvedValue(makeStatus())
        return {
          tag: 'master-849-d04e895',
          backendId: 'macos-arm64',
          backend: 'metal',
          engine: 'sd-cpp',
          sha256: null,
          installedAtMs: 1,
          dir: '/x',
        }
      })
      useImageGenerationStore.setState({
        status: makeStatus({ install: { state: 'not-installed' } }),
      })
      const run = useImageGenerationStore.getState().installEngine()
      await waitFor(() =>
        expect(useImageGenerationStore.getState().engineInstall.transferred).toBe(50)
      )
      await run
      const state = useImageGenerationStore.getState()
      expect(state.engineInstall.inFlight).toBe(false)
      expect(state.status?.install.state).toBe('installed')
      expect(captured.events.map(([name, props]) => [name, props.install_status, props.backend])).toEqual([
        ['image_engine_install', 'started', 'macos-arm64'],
        ['image_engine_install', 'completed', 'macos-arm64'],
      ])
    })

    it('keeps the failure on the install row and reports its code', async () => {
      install.ensure.mockRejectedValue({ code: 'UNSUPPORTED_BACKEND', message: 'no build' })
      await useImageGenerationStore.getState().installEngine({ force: true })
      const state = useImageGenerationStore.getState()
      expect(state.engineInstall.error?.code).toBe('UNSUPPORTED_BACKEND')
      expect(state.engineInstall.inFlight).toBe(false)
      expect(captured.events.at(-1)?.[1]).toMatchObject({
        install_status: 'failed',
        error_code: 'UNSUPPORTED_BACKEND',
      })
    })

    it('does not start a second install while one is running', async () => {
      let release: () => void = () => {}
      install.ensure.mockImplementation(
        () => new Promise((resolve) => { release = () => resolve({} as never) })
      )
      const first = useImageGenerationStore.getState().installEngine()
      await useImageGenerationStore.getState().installEngine()
      expect(install.ensure).toHaveBeenCalledTimes(1)
      expect(useImageGenerationStore.getState().engineInstall.inFlight).toBe(true)
      release()
      await first
      expect(useImageGenerationStore.getState().engineInstall.inFlight).toBe(false)
    })
  })

  describe('model residency', () => {
    it('unloads and forgets the capabilities', async () => {
      await useImageGenerationStore.getState().unloadModel()
      const state = useImageGenerationStore.getState()
      expect(state.capabilities).toBeNull()
      expect(state.status?.model.state).toBe('unloaded')
    })

    it('keeps an unload refusal as the last error', async () => {
      fake.unloadModel.mockRejectedValue({ code: 'JOB_BUSY', message: 'generating' })
      await useImageGenerationStore.getState().unloadModel()
      expect(useImageGenerationStore.getState().lastError?.code).toBe('JOB_BUSY')
    })

    it('removing the resident artifact unloads it first and clears the selection', async () => {
      useImageSetting.setState({ selectedArtifactId: 'z-image:q4_k_m' })
      fake.listModelFiles.mockResolvedValue([])
      await useImageGenerationStore.getState().removeArtifact('z-image:q4_k_m')
      expect(fake.unloadModel).toHaveBeenCalled()
      expect(useImageSetting.getState().selectedArtifactId).toBeNull()
      expect(useImageGenerationStore.getState().installedArtifacts).toEqual([])
    })

    it('ignores a removal of something the catalog does not know', async () => {
      await useImageGenerationStore.getState().removeArtifact('nope:q4')
      expect(fake.deleteModelFile).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().lastError).toBeNull()
    })

    it('pushes the idle-unload setting to the plugin', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      useImageSetting.setState({ keepModelLoaded: true })
      await useImageGenerationStore.getState().applyIdleSettings()
      expect(vi.mocked(configureDiffusion).mock.calls.at(-1)?.[0]).toEqual({ idleUnloadSecs: 0 })
      useImageSetting.setState({ keepModelLoaded: false, idleUnloadMinutes: 5 })
      await useImageGenerationStore.getState().applyIdleSettings()
      expect(vi.mocked(configureDiffusion).mock.calls.at(-1)?.[0]).toEqual({ idleUnloadSecs: 300 })
    })
  })

  describe('host without an engine build', () => {
    it('records the reason and never binds the event stream on an unsupported build', async () => {
      resetImageGenerationForTests()
      install.select.mockResolvedValue({ backendId: null, reason: 'Intel Macs are not supported.' })
      await useImageGenerationStore.getState().bind()
      expect(useImageGenerationStore.getState()).toMatchObject({
        hostBackendId: null,
        hostBackendReason: 'Intel Macs are not supported.',
      })

      resetImageGenerationForTests()
      fake.isSupported.mockReturnValue(false)
      fake.subscribe.mockClear()
      await useImageGenerationStore.getState().bind()
      expect(fake.subscribe).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().bound).toBe(true)
    })

    it('unbind drops the subscription so events no longer reach the store', async () => {
      useImageGenerationStore.getState().unbind()
      fake.emit({ type: 'state', status: makeStatus({ outputDir: '/elsewhere' }) })
      expect(useImageGenerationStore.getState().status?.outputDir).toBe('/data/images')
      expect(useImageGenerationStore.getState().bound).toBe(false)
    })

    it('opens and closes the setup wizard on a given step', () => {
      useImageGenerationStore.getState().openSetup(2)
      expect(useImageGenerationStore.getState()).toMatchObject({ setupOpen: true, setupStep: 2 })
      useImageGenerationStore.getState().closeSetup()
      expect(useImageGenerationStore.getState().setupOpen).toBe(false)
    })
  })
})
