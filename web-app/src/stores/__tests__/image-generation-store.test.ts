import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'
import { DownloadEvent, events } from '@janhq/core'

import {
  Z_IMAGE,
  makeCapabilities,
  makeCatalog,
  makeEngineCatalog,
  makeFakeDiffusion,
  makeItem,
  makeJob,
  makeLoadedStatus,
  makeRequest,
  makeStatus,
  MODELS_ROOT,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  LTX_2,
  LTX_Q4_ID,
  makeVideoCapabilities,
  makeVideoLoadedStatus,
} from '@/lib/diffusion/__tests__/video-fixtures'
import type { EngineVersionsResponse } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import { seedServiceHub } from '@/test/service-hub'
import { useHardware } from '@/hooks/useHardware'
import { useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'

// The store talks to the plugin through the hub (faked below) and to the
// catalog, config, arbiter and install modules — each of which has its own
// tests; here they are the environment, not the subject.
vi.mock('@/services/diffusion-catalog-registry', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/diffusion-catalog-registry')
  >()),
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
    videosDir: '/data/videos',
  })),
}))
vi.mock('@/lib/diffusion/arbiter', () => ({
  acquireGpuForDiffusion: vi.fn(async () => ({ evicted: [] })),
}))
const raiseServer = vi.hoisted(() => vi.fn(async () => {}))
vi.mock('@/utils/localApiServerControl', () => ({
  raiseLocalApiServerForMediaModel: raiseServer,
}))
// The core relays its download progress under the task id
// (`download-<task_id>`); the engine install listens there.
const relay = vi.hoisted(() => ({
  handlers: new Map<string, (event: { payload: unknown }) => void>(),
}))
vi.mock('@tauri-apps/api/event', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@tauri-apps/api/event')>()),
  listen: vi.fn(
    async (name: string, handler: (event: { payload: unknown }) => void) => {
      relay.handlers.set(name, handler)
      return () => relay.handlers.delete(name)
    }
  ),
}))
// The engine's update check and its update are the core's `/engines` routes.
const engines = vi.hoisted(() => ({
  updateEngine: vi.fn(),
  engineVersions: vi.fn(),
}))
vi.mock('@/services/engines/core', () => engines)
vi.mock('@/lib/notifications', () => ({ notifyWhenAway: vi.fn() }))
const captured = vi.hoisted(() => ({
  events: [] as Array<[string, Record<string, unknown>]>,
}))
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
const emitLater = (
  fake: FakeDiffusion,
  jobs: () => Parameters<FakeDiffusion['emit']>[0]
) => setTimeout(() => fake.emit(jobs()), 0)

const QWEN_TAG = 'master-883-137f740-a36f1b1a'

/** The core's answer to an install that put `tag` in place on this Mac. */
const installed = (tag: string, backendId = 'macos-arm64') => ({
  installed: true,
  build: { tag, backend_id: backendId, origin: 'downloaded' as const },
  retired: [],
  kept_in_use: [],
})

/** The core's answer to an update that made `tag` the active build. */
const updated = (tag: string) => ({
  updated: true,
  active: { version: tag, variant: 'macos-arm64' },
  retired: [],
  kept_in_use: [],
})

/** The core's versions answer for sd.cpp, offering `target` (or nothing). */
const sdVersions = (
  target: string | null,
  active = 'master-849-d04e895'
): EngineVersionsResponse => ({
  engines: [
    {
      engine: 'sd-cpp',
      kind: 'engine-build',
      active_choice: 'core',
      builds: [],
      active: { version: active, variant: 'macos-arm64' },
      latest: target ? { version: target, variant: 'macos-arm64' } : null,
      update: {
        needed: target !== null,
        target: target
          ? {
              version: target,
              variant: 'macos-arm64',
              download_bytes: 40_000_000,
            }
          : null,
        apply: 'swap',
      },
      source: 'remote',
      source_error: null,
      error: null,
    },
  ],
})

/** Push a progress frame the core sent for `taskId`, the way the relay does. */
const relayProgress = (taskId: string, transferred: number, total: number) =>
  relay.handlers.get(`download-${taskId}`)?.({
    payload: { transferred, total },
  })

describe('image-generation-store', () => {
  let fake: FakeDiffusion

  beforeEach(async () => {
    vi.useRealTimers()
    captured.events.length = 0
    raiseServer.mockClear()
    relay.handlers.clear()
    useImageSetting.setState({
      selectedArtifactId: null,
      keepModelLoaded: false,
      idleUnloadMinutes: 10,
      outputDir: null,
      offloadOverride: 'auto',
    })
    useVideoSetting.setState({ selectedArtifactId: null, outputDir: null })
    resetImageGenerationForTests()
    useEngineVersionsStore.getState().reset()
    engines.updateEngine.mockReset()
    engines.engineVersions.mockReset()
    engines.engineVersions.mockResolvedValue({ engines: [] })
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
    it.each(['gallery', 'live'] as const)(
      'honors the %s preview selection across repeated job completions',
      async (mode) => {
        const gallery = useImageGalleryStore.getState()
        gallery.prepend([makeItem({ id: 'ready-00' })])
        gallery.select('ready-00')
        let run = 0
        fake.generate.mockImplementation(async (request) => {
          const id = `new-${++run}`
          if (run === 1) {
            // A new Generate action resets a previous deliberate selection.
            expect(useImageGalleryStore.getState().viewerMode).toBe('live')
            gallery.select('ready-00')
            if (mode === 'live') gallery.selectLive()
          } else {
            expect(useImageGalleryStore.getState().viewerMode).toBe(mode)
          }
          emitLater(fake, () => ({
            type: 'job',
            job: makeJob({
              id,
              state: 'completed',
              request,
              outputs: [makeItem({ id: `${id}-00` })],
            }),
          }))
          return { jobId: id }
        })

        await useImageGenerationStore.getState().startGeneration({
          request: makeRequest(),
          runs: 2,
          baseSeed: 100,
        })

        expect(useImageGenerationStore.getState().generating).toBe(false)
        expect(useImageGalleryStore.getState().items).toHaveLength(3)
        expect(useImageGalleryStore.getState().selectedId).toBe(
          mode === 'gallery' ? 'ready-00' : 'new-2-00'
        )
      }
    )

    it('shows a picture made by a job this page did not start, and never doubles one of its own', async () => {
      // An outside client on `/v1/images/generations` runs a job the core reports like any other.
      fake.emit({
        type: 'job',
        job: makeJob({
          id: 'outside-1',
          state: 'completed',
          outputs: [makeItem({ id: 'outside-1-00' })],
        }),
      })
      expect(
        useImageGalleryStore.getState().items.map((item) => item.id)
      ).toEqual(['outside-1-00'])
      expect(useImageGalleryStore.getState().total).toBe(1)
      // Not a picture yet: nothing to show for a job still running, and nothing for one that failed.
      fake.emit({
        type: 'job',
        job: makeJob({ id: 'outside-2', state: 'generating', outputs: [] }),
      })
      fake.emit({
        type: 'job',
        job: makeJob({ id: 'outside-3', state: 'failed', outputs: [] }),
      })
      expect(useImageGalleryStore.getState().items).toHaveLength(1)

      // A job of this page's own is shown once, by the run loop, not twice.
      fake.generate.mockImplementation(async (request) => {
        emitLater(fake, () => ({
          type: 'job',
          job: makeJob({
            id: 'own-1',
            state: 'completed',
            request,
            outputs: [makeItem({ id: 'own-1-00' })],
          }),
        }))
        return { jobId: 'own-1' }
      })
      await useImageGenerationStore
        .getState()
        .startGeneration({ request: makeRequest(), runs: 1, baseSeed: null })
      expect(
        useImageGalleryStore.getState().items.map((item) => item.id)
      ).toEqual(['own-1-00', 'outside-1-00'])
      expect(useImageGalleryStore.getState().total).toBe(2)
    })

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
            outputs: [
              makeItem({ id: `${id}-00` }),
              makeItem({ id: `${id}-01` }),
            ],
          }),
        }))
        return { jobId: id }
      })

      await useImageGenerationStore.getState().startGeneration({
        request: makeRequest({ batchSize: 2 }),
        runs: 3,
        baseSeed: 100,
      })

      expect(fake.generate.mock.calls.map(([request]) => request.seed)).toEqual(
        [100, 102, 104]
      )
      // Newest batch first, its images in order.
      expect(
        useImageGalleryStore.getState().items.map((item) => item.id)
      ).toEqual([
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
      expect(
        captured.events.map(([name, props]) => [
          name,
          props.generate_status,
          props.error_code,
        ])
      ).toEqual([['image_generate', 'failed', 'OUT_OF_MEMORY']])
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
        request: makeRequest({
          prompt: 'secret garden',
          width: 768,
          height: 512,
        }),
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
        makeJob({
          id: 'job-1',
          state: 'completed',
          outputs: [makeItem({ id: 'job-1-00' })],
        })
      )
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await vi.advanceTimersByTimeAsync(2_100)
      await done
      expect(
        useImageGalleryStore.getState().items.map((item) => item.id)
      ).toEqual(['job-1-00'])
      expect(useImageGenerationStore.getState().generating).toBe(false)
    })

    it('tracks final sampling, decode, post-process and save events through completion', async () => {
      fake.generate.mockImplementation(async () => ({ jobId: 'job-1' }))
      const done = useImageGenerationStore.getState().startGeneration({
        request: makeRequest(),
        runs: 1,
        baseSeed: null,
      })
      await waitFor(() =>
        expect(useImageGenerationStore.getState().currentJob?.id).toBe('job-1')
      )
      const progress = {
        phase: 'sampling' as const,
        step: 8,
        totalSteps: 8,
        fraction: 0.97,
        etaSeconds: null,
        batchIndex: 0,
        batchSize: 1,
        elapsedMs: 2000,
      }
      for (const phase of [
        'sampling',
        'decoding',
        'postprocessing',
        'saving',
      ] as const) {
        fake.emit({
          type: 'progress',
          jobId: 'job-1',
          progress: { ...progress, phase },
        })
        expect(useImageGenerationStore.getState().currentJob).toMatchObject({
          state: 'generating',
          progress: { phase, step: 8, totalSteps: 8, etaSeconds: null },
        })
      }
      fake.emit({
        type: 'job',
        job: makeJob({
          id: 'job-1',
          state: 'completed',
          outputs: [makeItem({ id: 'job-1-00' })],
        }),
      })
      await done
      expect(useImageGenerationStore.getState().currentJob).toBeNull()
      expect(useImageGalleryStore.getState().items[0]?.id).toBe('job-1-00')
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
      expect(useImageGenerationStore.getState().status?.model.state).toBe(
        'unloaded'
      )
    })

    it('configures a new core generation again and takes its status as the truth', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      const configure = vi.mocked(configureDiffusion)
      configure.mockClear()
      useImageGenerationStore.setState({
        status: makeLoadedStatus(),
        capabilities: makeCapabilities(),
      })
      fake.emit({ type: 'reset', generation: 2 })
      await waitFor(() => expect(configure).toHaveBeenCalledTimes(1))
      await waitFor(() =>
        expect(useImageGenerationStore.getState().status?.model.state).toBe(
          'unloaded'
        )
      )
      expect(useImageGenerationStore.getState().capabilities).toBeNull()
    })

    it('sends the stored output folder on bind and again on a new core generation', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      const configure = vi.mocked(configureDiffusion)
      useImageSetting.setState({ outputDir: '/Users/me/Pictures/AI' })
      configure.mockClear()
      resetImageGenerationForTests()
      await useImageGenerationStore.getState().bind()
      expect(configure.mock.calls.map(([settings]) => settings)).toEqual([
        { idleUnloadSecs: 600, outputDir: '/Users/me/Pictures/AI' },
      ])

      fake.emit({ type: 'reset', generation: 2 })
      await waitFor(() => expect(configure).toHaveBeenCalledTimes(2))
      expect(configure.mock.calls[1][0]).toEqual({
        idleUnloadSecs: 600,
        outputDir: '/Users/me/Pictures/AI',
      })
    })

    it('falls back to the default folder when the stored one is unusable, and keeps the choice', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      const configure = vi.mocked(configureDiffusion)
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      // What the core throws when it cannot create the folder (a drive that
      // is not plugged in): an I/O failure, reported as INTERNAL.
      const unusable = {
        code: 'INTERNAL',
        message: 'Could not create the output folder.',
        details: "EACCES: permission denied, mkdir '/Volumes/Gone'",
      }
      useImageSetting.setState({ outputDir: '/Volumes/Gone/AI' })
      try {
        configure.mockClear()
        configure.mockRejectedValueOnce(unusable)
        resetImageGenerationForTests()
        await useImageGenerationStore.getState().bind()
        expect(configure.mock.calls.map(([settings]) => settings)).toEqual([
          { idleUnloadSecs: 600, outputDir: '/Volumes/Gone/AI' },
          { idleUnloadSecs: 600 },
        ])
        expect(useImageGenerationStore.getState().lastError).toBeNull()

        // A new core generation the same way, and it still ends with a status.
        configure.mockClear()
        configure.mockRejectedValueOnce(unusable)
        useImageGenerationStore.setState({ status: null })
        fake.emit({ type: 'reset', generation: 3 })
        await waitFor(() =>
          expect(useImageGenerationStore.getState().status?.outputDir).toBe(
            '/data/images'
          )
        )
        expect(configure.mock.calls.map(([settings]) => settings)).toEqual([
          { idleUnloadSecs: 600, outputDir: '/Volumes/Gone/AI' },
          { idleUnloadSecs: 600 },
        ])
        expect(useImageSetting.getState().outputDir).toBe('/Volumes/Gone/AI')
        expect(warn).toHaveBeenCalled()
      } finally {
        warn.mockRestore()
      }
    })

    it('does not drop the stored folder when the core itself is down', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      const configure = vi.mocked(configureDiffusion)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      useImageSetting.setState({ outputDir: '/Users/me/Pictures/AI' })
      try {
        configure.mockClear()
        configure.mockRejectedValueOnce({
          code: 'CORE_UNREACHABLE',
          message: 'The Atomic Chat core did not answer.',
        })
        resetImageGenerationForTests()
        await useImageGenerationStore.getState().bind()
        expect(configure.mock.calls.map(([settings]) => settings)).toEqual([
          { idleUnloadSecs: 600, outputDir: '/Users/me/Pictures/AI' },
        ])
        expect(useImageGenerationStore.getState().lastError?.details).toBe(
          'CORE_UNREACHABLE'
        )
        expect(useImageSetting.getState().outputDir).toBe(
          '/Users/me/Pictures/AI'
        )
      } finally {
        error.mockRestore()
      }
    })

    it('reports a configure failure, message kept, when no folder is stored to blame', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      const configure = vi.mocked(configureDiffusion)
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      try {
        configure.mockClear()
        configure.mockRejectedValueOnce({
          code: 'CORE_UNREACHABLE',
          message: 'The core is not reachable.',
        })
        resetImageGenerationForTests()
        await useImageGenerationStore.getState().bind()
        expect(configure).toHaveBeenCalledTimes(1)
        expect(useImageGenerationStore.getState().lastError).toEqual({
          code: 'INTERNAL',
          message: 'The core is not reachable.',
          details: 'CORE_UNREACHABLE',
        })
      } finally {
        error.mockRestore()
      }
    })
  })

  describe('loadModel', () => {
    it('gates an existing 849 profile, reuses model files, and retries after updating', async () => {
      useImageGenerationStore.setState({
        catalog: makeCatalog([{ ...Z_IMAGE, id: 'qwen-image-2.1' }]),
      })
      await useImageGenerationStore
        .getState()
        .loadModel('qwen-image-2.1:q4_k_m')
      expect(fake.loadModel).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'ENGINE_UPDATE_REQUIRED'
      )
      expect(useImageGenerationStore.getState().engineUpdate.availableTag).toBe(
        'master-883-137f740'
      )
      // The config manifest names the fork's 883 build; the core installs it
      // and unloads what ran from the old one itself.
      fake.engineCatalog.mockResolvedValue(
        makeEngineCatalog({
          manifest: {
            tag: QWEN_TAG,
            source: 'remote',
            fetched_at: 2,
            error: null,
          },
        })
      )
      engines.updateEngine.mockImplementation(async () => {
        const status = makeStatus()
        if (status.install.state !== 'installed') throw new Error('fixture')
        status.install.tag = QWEN_TAG
        fake.emit({ type: 'state', status })
        return updated(QWEN_TAG)
      })
      await useImageGenerationStore.getState().updateEngine()
      expect(fake.unloadModel).not.toHaveBeenCalled()
      expect(fake.installEngine).not.toHaveBeenCalled()
      // The core's update, under the task id the download panel knows.
      expect(engines.updateEngine).toHaveBeenCalledWith('sd-cpp', {
        task_id: 'diffusion-backend-master-883-137f740-macos-arm64',
        app_version: 'test',
      })
      expect(fake.loadModel).toHaveBeenCalledTimes(1)
      expect(fake.loadModel.mock.calls[0][0].modelId).toBe(
        'qwen-image-2.1:q4_k_m'
      )
      expect(useImageGenerationStore.getState().lastError).toBeNull()
      expect(
        useImageGenerationStore.getState().pendingEngineArtifactId
      ).toBeNull()
    })

    it('keeps the model blocked after a failed engine update and permits retry', async () => {
      useImageGenerationStore.setState({
        catalog: makeCatalog([{ ...Z_IMAGE, id: 'qwen-image-2.1' }]),
      })
      await useImageGenerationStore
        .getState()
        .loadModel('qwen-image-2.1:q4_k_m')
      engines.updateEngine.mockRejectedValue({
        code: 'ENGINE_INSTALL_FAILED',
        message: 'offline',
      })
      await useImageGenerationStore.getState().updateEngine()
      expect(engines.updateEngine).toHaveBeenCalledTimes(1)
      expect(fake.loadModel).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().pendingEngineArtifactId).toBe(
        'qwen-image-2.1:q4_k_m'
      )
      expect(useImageGenerationStore.getState().engineUpdate.availableTag).toBe(
        'master-883-137f740'
      )
      await useImageGenerationStore
        .getState()
        .loadModel('qwen-image-2.1:q4_k_m')
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'ENGINE_UPDATE_REQUIRED'
      )
    })

    it('says no newer engine is published when the core installs nothing, and leaves the model blocked', async () => {
      useImageGenerationStore.setState({
        catalog: makeCatalog([{ ...Z_IMAGE, id: 'qwen-image-2.1' }]),
      })
      await useImageGenerationStore
        .getState()
        .loadModel('qwen-image-2.1:q4_k_m')
      // conf's manifest still names the installed 849 build.
      engines.updateEngine.mockResolvedValue({
        ...updated('master-849-d04e895'),
        updated: false,
        reason: 'no-update',
      })
      await useImageGenerationStore.getState().updateEngine()
      const state = useImageGenerationStore.getState()
      expect(fake.loadModel).not.toHaveBeenCalled()
      expect(state.lastError?.code).toBe('ENGINE_UPDATE_REQUIRED')
      expect(state.lastError?.message).toMatch(/no newer media engine/i)
      expect(state.pendingEngineArtifactId).toBe('qwen-image-2.1:q4_k_m')
    })

    it('loads Qwen with an already compatible engine without requesting an update', async () => {
      const status = makeStatus()
      if (status.install.state !== 'installed') throw new Error('fixture')
      status.install.tag = 'master-883-137f740'
      fake.emit({ type: 'state', status })
      useImageGenerationStore.setState({
        catalog: makeCatalog([{ ...Z_IMAGE, id: 'qwen-image-2.1' }]),
      })
      await useImageGenerationStore
        .getState()
        .loadModel('qwen-image-2.1:q4_k_m')
      expect(fake.loadModel).toHaveBeenCalledTimes(1)
      expect(fake.installEngine).not.toHaveBeenCalled()
      // Qwen is the resident model, and nothing is left waiting on an engine
      // update: no error, no parked artifact, no update on offer.
      expect(fake.loadModel.mock.calls[0][0].modelId).toBe(
        'qwen-image-2.1:q4_k_m'
      )
      const state = useImageGenerationStore.getState()
      expect(state.status?.model.loaded?.modelId).toBe('qwen-image-2.1:q4_k_m')
      expect(state.lastError).toBeNull()
      expect(state.pendingEngineArtifactId).toBeNull()
      expect(state.engineUpdate.availableTag).toBeNull()
      expect(useImageSetting.getState().selectedArtifactId).toBe(
        'qwen-image-2.1:q4_k_m'
      )
    })

    it('hands the plugin the resolved files and reads the capabilities back', async () => {
      useImageGenerationStore.setState({
        status: makeStatus(),
        capabilities: null,
      })

      await useImageGenerationStore.getState().loadModel('z-image:q4_k_m')

      const request = fake.loadModel.mock.calls[0][0]
      expect(request).toMatchObject({
        modelId: 'z-image:q4_k_m',
        family: 'z-image',
        modality: 'image',
      })
      expect(request.files.diffusionModel).toContain(
        'z-image-turbo-Q4_K_M.gguf'
      )
      expect(request.files.llm).toContain('Qwen3-4B-Q4_K_M.gguf')
      const state = useImageGenerationStore.getState()
      expect(state.capabilities?.maxBatch).toBe(4)
      expect(state.status?.model.loaded?.modelId).toBe('z-image:q4_k_m')
      expect(state.loadingArtifactId).toBeNull()
      expect(state.lastError).toBeNull()
    })

    it('honours a memory override instead of the fit policy', async () => {
      useImageGenerationStore.setState({
        status: makeStatus(),
        capabilities: null,
      })
      useImageSetting.setState({ offloadOverride: 'model' })

      await useImageGenerationStore.getState().loadModel('z-image:q4_k_m')

      expect(fake.loadModel.mock.calls[0][0].offload).toBe('model')
      expect(fake.loadModel.mock.calls[0][0]).not.toHaveProperty(
        'offloadFallback'
      )
    })

    it('keeps Auto on a 12 GB card on the GPU and leaves offloading to a shortage', async () => {
      const hardware = useHardware.getState().hardwareData
      useHardware.setState({
        hardwareData: {
          ...hardware,
          os_type: 'windows',
          total_memory: 32768,
          gpus: [
            {
              name: 'NVIDIA GeForce RTX 3060',
              total_memory: 12288,
              vendor: 'NVIDIA',
              uuid: 'gpu-0',
              driver_version: '',
              nvidia_info: { index: 0, compute_capability: '8.6' },
              vulkan_info: {
                index: 0,
                device_id: 0,
                device_type: '',
                api_version: '',
              },
            },
          ],
        },
      })
      useImageGenerationStore.setState({
        status: makeStatus(),
        capabilities: null,
      })
      try {
        await useImageGenerationStore.getState().loadModel('z-image:q4_k_m')
      } finally {
        useHardware.setState({ hardwareData: hardware })
      }

      // The estimate alone would offload Z-Image in groups on this card.
      expect(fake.loadModel.mock.calls[0][0]).toMatchObject({
        offload: 'none',
        offloadFallback: 'group',
      })
    })

    it('reports an unknown artifact as a missing model', async () => {
      await useImageGenerationStore.getState().loadModel('z-image:nope')
      expect(fake.loadModel).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'MODEL_MISSING'
      )
    })

    it('keeps a plugin refusal as the last error', async () => {
      fake.loadModel.mockRejectedValue({
        code: 'OUT_OF_MEMORY',
        message: 'no vram',
      })
      await useImageGenerationStore.getState().loadModel('z-image:q8_0')
      expect(useImageGenerationStore.getState().lastError).toMatchObject({
        code: 'OUT_OF_MEMORY',
      })
      expect(useImageGenerationStore.getState().loadingArtifactId).toBeNull()
      // Nothing is resident, so there is nothing for the Local API Server to serve.
      expect(raiseServer).not.toHaveBeenCalled()
    })

    // `/v1/images/generations` lives on the Local API Server, which used to come up only with a
    // chat model: an image-only user had a working Images page and a dead endpoint.
    it('raises the Local API Server once the image model is resident', async () => {
      useImageGenerationStore.setState({ status: makeStatus(), capabilities: null })
      let residentWhenRaised: string | null | undefined
      raiseServer.mockImplementationOnce(async () => {
        residentWhenRaised =
          useImageGenerationStore.getState().status?.model.loaded?.modelId
      })

      await useImageGenerationStore.getState().loadModel('z-image:q4_k_m')

      expect(raiseServer).toHaveBeenCalledTimes(1)
      expect(residentWhenRaised).toBe('z-image:q4_k_m')
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
      fake.emit({
        type: 'job',
        job: makeJob({ id: 'job-1', state: 'completed' }),
      })
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
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'JOB_NOT_FOUND'
      )
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
      fake.emit({
        type: 'error',
        jobId: 'other',
        code: 'INTERNAL',
        message: 'elsewhere',
      })
      expect(useImageGenerationStore.getState().lastError).toBeNull()

      fake.emit({
        type: 'error',
        jobId: 'job-1',
        code: 'ENGINE_CRASHED',
        message: 'sd-server died',
      })
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'ENGINE_CRASHED'
      )

      useImageGenerationStore.setState({ lastError: null, stopRequested: true })
      fake.emit({
        type: 'error',
        jobId: 'job-1',
        code: 'CANCELLED',
        message: 'stopped',
      })
      expect(useImageGenerationStore.getState().lastError).toBeNull()

      fake.emit({
        type: 'job',
        job: makeJob({ id: 'job-1', state: 'cancelled' }),
      })
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
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'MODEL_LOAD_FAILED'
      )
      useImageGenerationStore.getState().clearError()
      expect(useImageGenerationStore.getState().lastError).toBeNull()
    })
  })

  describe('engine install', () => {
    const TASK = 'diffusion-backend-master-849-d04e895-macos-arm64'

    beforeEach(() => {
      fake.engineCatalog.mockResolvedValue(makeEngineCatalog({ tag: null }))
      useImageGenerationStore.setState({
        status: makeStatus({ install: { state: 'not-installed' } }),
      })
    })

    it('installs through the core under its task id, tracks the core\'s progress, then reads the installed status', async () => {
      const emit = vi.spyOn(events, 'emit')
      let finish: () => void = () => {}
      fake.installEngine.mockImplementation(async () => {
        relayProgress(TASK, 50, 100)
        await new Promise<void>((resolve) => {
          finish = resolve
        })
        fake.getStatus.mockResolvedValue(makeStatus())
        return installed('master-849-d04e895')
      })
      const run = useImageGenerationStore.getState().installEngine()
      await waitFor(() =>
        expect(
          useImageGenerationStore.getState().engineInstall.transferred
        ).toBe(50)
      )
      finish()
      await run
      const panel = emit.mock.calls
        .filter(([name]) => name === DownloadEvent.onFileDownloadUpdate)
        .map(([, state]) => state)
      emit.mockRestore()

      expect(fake.installEngine).toHaveBeenCalledWith({ task_id: TASK })
      // The download panel's row is the same task, fed by the same frames.
      expect(panel).toContainEqual(
        expect.objectContaining({
          modelId: TASK,
          downloadType: 'Backend',
          size: { transferred: 50, total: 100 },
        })
      )
      const state = useImageGenerationStore.getState()
      expect(state.engineInstall.inFlight).toBe(false)
      expect(state.engineInstall.error).toBeNull()
      expect(state.status?.install.state).toBe('installed')
      expect(relay.handlers.has(`download-${TASK}`)).toBe(false)
      expect(
        captured.events.map(([name, props]) => [
          name,
          props.install_status,
          props.backend,
        ])
      ).toEqual([
        ['image_engine_install', 'started', 'macos-arm64'],
        ['image_engine_install', 'completed', 'macos-arm64'],
      ])
    })

    it('reinstalls with force', async () => {
      fake.installEngine.mockResolvedValue(installed('master-849-d04e895'))
      await useImageGenerationStore.getState().installEngine({ force: true })
      expect(fake.installEngine).toHaveBeenCalledWith({
        task_id: TASK,
        force: true,
      })
      expect(useImageGenerationStore.getState().engineInstall).toEqual({
        inFlight: false,
        transferred: 0,
        total: 0,
        error: null,
      })
    })

    it('takes the build the core went down the ladder to as the host\'s', async () => {
      fake.engineCatalog.mockResolvedValue(
        makeEngineCatalog({ tag: null, host_backend_id: 'win-rocm-x64' })
      )
      fake.installEngine.mockResolvedValue({
        ...installed('master-849-d04e895', 'win-vulkan-x64'),
        failed_backend_ids: ['win-rocm-x64'],
      })
      await useImageGenerationStore.getState().installEngine()
      expect(fake.installEngine).toHaveBeenCalledWith({
        task_id: 'diffusion-backend-master-849-d04e895-win-rocm-x64',
      })
      expect(useImageGenerationStore.getState().hostBackendId).toBe(
        'win-vulkan-x64'
      )
    })

    it('turns the core\'s refusal into the diffusion code the card routes on', async () => {
      fake.installEngine.mockRejectedValue({
        code: 'BACKEND_INSUFFICIENT_DISK_SPACE',
        message: 'Not enough free disk space.',
      })
      await useImageGenerationStore.getState().installEngine({ force: true })
      const state = useImageGenerationStore.getState()
      expect(state.engineInstall.error).toMatchObject({
        code: 'DISK_FULL',
        message: 'Not enough free disk space.',
      })
      expect(state.engineInstall.inFlight).toBe(false)
      expect(captured.events.at(-1)?.[1]).toMatchObject({
        install_status: 'failed',
        error_code: 'DISK_FULL',
      })
    })

    it('never asks the core to install on a host it has no build for', async () => {
      fake.engineCatalog.mockResolvedValue(
        makeEngineCatalog({
          tag: null,
          host_backend_id: null,
          host_reason: 'Intel Macs are not supported.',
        })
      )
      await useImageGenerationStore.getState().installEngine()
      expect(fake.installEngine).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().engineInstall.error).toEqual({
        code: 'UNSUPPORTED_BACKEND',
        message: 'Intel Macs are not supported.',
      })
    })

    it('goes back to "not installed" with no error when the user cancels', async () => {
      const emit = vi.spyOn(events, 'emit')
      fake.installEngine.mockImplementation(async () => {
        relayProgress(TASK, 10, 100)
        throw { code: 'CANCELLED', message: 'The engine install was cancelled.' }
      })
      await useImageGenerationStore.getState().installEngine()
      const stopped = emit.mock.calls.filter(
        ([name]) => name === DownloadEvent.onFileDownloadStopped
      )
      const failed = emit.mock.calls.filter(
        ([name]) => name === DownloadEvent.onFileDownloadError
      )
      emit.mockRestore()

      expect(useImageGenerationStore.getState().engineInstall).toEqual({
        inFlight: false,
        transferred: 0,
        total: 0,
        error: null,
      })
      // The panel closes the row as a cancel, not as a failure.
      expect(stopped).toEqual([
        [
          DownloadEvent.onFileDownloadStopped,
          { modelId: TASK, downloadType: 'Backend' },
        ],
      ])
      expect(failed).toEqual([])
    })

    it('does not start a second install while one is running', async () => {
      let release: () => void = () => {}
      fake.installEngine.mockImplementation(
        () =>
          new Promise((resolve) => {
            release = () => resolve(installed('master-849-d04e895'))
          })
      )
      const first = useImageGenerationStore.getState().installEngine()
      await useImageGenerationStore.getState().installEngine()
      await waitFor(() => expect(fake.installEngine).toHaveBeenCalledTimes(1))
      expect(useImageGenerationStore.getState().engineInstall.inFlight).toBe(
        true
      )
      release()
      await first
      expect(fake.installEngine).toHaveBeenCalledTimes(1)
      expect(useImageGenerationStore.getState().engineInstall.inFlight).toBe(
        false
      )
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
      fake.unloadModel.mockRejectedValue({
        code: 'JOB_BUSY',
        message: 'generating',
      })
      await useImageGenerationStore.getState().unloadModel()
      expect(useImageGenerationStore.getState().lastError?.code).toBe(
        'JOB_BUSY'
      )
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
      expect(vi.mocked(configureDiffusion).mock.calls.at(-1)?.[0]).toEqual({
        idleUnloadSecs: 0,
      })
      useImageSetting.setState({ keepModelLoaded: false, idleUnloadMinutes: 5 })
      await useImageGenerationStore.getState().applyIdleSettings()
      expect(vi.mocked(configureDiffusion).mock.calls.at(-1)?.[0]).toEqual({
        idleUnloadSecs: 300,
      })
    })
  })

  describe('caches of the desktop sd.cpp installer', () => {
    it('erases the manifest cache and the failed-build list on start: the core keeps both now', async () => {
      for (const key of [
        'atomic_sdcpp_manifest_cache_v1',
        'atomic_sdcpp_manifest_cache_ts_v1',
        'atomic_sdcpp_failed_backends_v1',
      ])
        localStorage.setItem(key, '1')
      localStorage.setItem('atomic_engine_update_offer_llamacpp', '{}')
      resetImageGenerationForTests()
      await useImageGenerationStore.getState().bind()
      expect(localStorage.getItem('atomic_sdcpp_manifest_cache_v1')).toBeNull()
      expect(localStorage.getItem('atomic_sdcpp_manifest_cache_ts_v1')).toBeNull()
      expect(localStorage.getItem('atomic_sdcpp_failed_backends_v1')).toBeNull()
      // Not a cache of the installer: another engine's offer stays.
      expect(
        localStorage.getItem('atomic_engine_update_offer_llamacpp')
      ).not.toBeNull()
      localStorage.clear()
    })
  })

  describe('host without an engine build', () => {
    it('records the reason and never binds the event stream on an unsupported build', async () => {
      resetImageGenerationForTests()
      fake.engineCatalog.mockResolvedValue(
        makeEngineCatalog({
          tag: null,
          host_backend_id: null,
          host_reason: 'Intel Macs are not supported.',
        })
      )
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
      fake.emit({
        type: 'state',
        status: makeStatus({ outputDir: '/elsewhere' }),
      })
      expect(useImageGenerationStore.getState().status?.outputDir).toBe(
        '/data/images'
      )
      expect(useImageGenerationStore.getState().bound).toBe(false)
    })

    it('opens and closes the model-list dialog for a given page', () => {
      useImageGenerationStore.getState().openSetup()
      expect(useImageGenerationStore.getState()).toMatchObject({
        setupOpen: true,
        setupModality: 'image',
      })
      useImageGenerationStore.getState().closeSetup()
      expect(useImageGenerationStore.getState().setupOpen).toBe(false)
      useImageGenerationStore.getState().openSetup('video')
      expect(useImageGenerationStore.getState()).toMatchObject({
        setupOpen: true,
        setupModality: 'video',
      })
    })
  })

  describe('video models', () => {
    beforeEach(() => {
      useImageGenerationStore.setState({
        catalog: makeCatalog([Z_IMAGE, LTX_2]),
        status: makeStatus(),
        capabilities: null,
      })
      fake.getVideoCapabilities.mockResolvedValue(makeVideoCapabilities())
    })

    it('loads a video checkpoint into the video slot, leaving both forms as they were', async () => {
      useImageSetting.setState({ selectedArtifactId: 'z-image:q4_k_m' })
      useImageForm.setState({ steps: 17 })
      useVideoForm.setState({ frames: 25, steps: 3, width: 704, height: 1216 })
      fake.loadModel.mockImplementation(async (request) => {
        const status = makeVideoLoadedStatus(request.modelId)
        fake.getStatus.mockResolvedValue(status)
        return status.model.loaded!
      })

      await useImageGenerationStore.getState().loadModel(LTX_Q4_ID)

      const request = fake.loadModel.mock.calls[0][0]
      expect(request).toMatchObject({
        modelId: LTX_Q4_ID,
        family: 'ltx-2',
        modality: 'video',
      })
      expect(request.files.audioVae).toContain('ltx-2.3-22b-distilled_audio_vae')
      expect(request.files.embeddingsConnectors).toContain('embeddings_connectors')
      expect(request.defaults.video?.frames).toBe(121)
      expect(fake.getCapabilities).not.toHaveBeenCalled()
      const state = useImageGenerationStore.getState()
      expect(state.videoCapabilities?.fps).toBe(24)
      expect(state.capabilities).toBeNull()
      expect(state.lastError).toBeNull()
      expect(useVideoSetting.getState().selectedArtifactId).toBe(LTX_Q4_ID)
      expect(useImageSetting.getState().selectedArtifactId).toBe('z-image:q4_k_m')
      // Loading touches neither form: what was set before the start is what
      // generates. The page makes a draft a new family's when it picks one.
      expect(useVideoForm.getState()).toMatchObject({
        frames: 25,
        steps: 3,
        width: 704,
        height: 1216,
      })
      expect(useImageForm.getState().steps).toBe(17)
    })

    it('counts the audio VAE among the bytes the GPU must find room for', async () => {
      const { acquireGpuForDiffusion } = await import('@/lib/diffusion/arbiter')
      vi.mocked(acquireGpuForDiffusion).mockClear()
      await useImageGenerationStore.getState().loadModel(LTX_Q4_ID)
      const [{ requiredBytes }] = vi.mocked(acquireGpuForDiffusion).mock.calls[0]
      // Transformer + video VAE + audio VAE, plus the text encoders unless
      // they sit on the CPU (macOS).
      expect(requiredBytes).toBe(
        14_000_000_000 +
          1_400_000_000 +
          360_000_000 +
          (IS_MACOS ? 0 : 7_400_000_000 + 2_300_000_000)
      )
    })

    it('raises the Local API Server for a video model too', async () => {
      fake.loadModel.mockImplementation(async (request) => {
        const status = makeVideoLoadedStatus(request.modelId)
        fake.getStatus.mockResolvedValue(status)
        return status.model.loaded!
      })
      let residentWhenRaised: string | null | undefined
      raiseServer.mockImplementationOnce(async () => {
        residentWhenRaised =
          useImageGenerationStore.getState().status?.model.loaded?.modelId
      })

      await useImageGenerationStore.getState().loadModel(LTX_Q4_ID)

      expect(raiseServer).toHaveBeenCalledTimes(1)
      expect(residentWhenRaised).toBe(LTX_Q4_ID)
    })

    it('files a failed video load under the Video page', async () => {
      fake.loadModel.mockRejectedValue({
        code: 'OUT_OF_MEMORY',
        message: 'no room',
      })
      await useImageGenerationStore.getState().loadModel(LTX_Q4_ID)
      expect(useImageGenerationStore.getState()).toMatchObject({
        lastError: { code: 'OUT_OF_MEMORY' },
        lastErrorModality: 'video',
      })
      expect(useVideoSetting.getState().selectedArtifactId).toBeNull()

      fake.loadModel.mockRejectedValue({ code: 'OUT_OF_MEMORY', message: 'x' })
      await useImageGenerationStore.getState().loadModel('z-image:q4_k_m')
      expect(useImageGenerationStore.getState().lastErrorModality).toBe('image')

      useImageGenerationStore.getState().clearError()
      expect(useImageGenerationStore.getState()).toMatchObject({
        lastError: null,
        lastErrorModality: null,
      })
    })

    it('reads the video capabilities when a video model turns out to be resident', async () => {
      fake.emit({
        type: 'state',
        status: makeVideoLoadedStatus(),
        reason: 'loaded',
      })
      await waitFor(() =>
        expect(useImageGenerationStore.getState().videoCapabilities?.frames.step).toBe(8)
      )
      expect(fake.getCapabilities).not.toHaveBeenCalled()
      expect(useImageGenerationStore.getState().capabilities).toBeNull()

      // Gone again: both slots empty.
      fake.emit({ type: 'state', status: makeStatus(), reason: 'idle' })
      expect(useImageGenerationStore.getState().videoCapabilities).toBeNull()

      // A model error while a video model was loading is the Video page's.
      useImageGenerationStore.setState({ loadingArtifactId: LTX_Q4_ID })
      fake.emit({
        type: 'state',
        status: makeStatus({
          model: {
            state: 'error',
            loaded: null,
            error: { code: 'ENGINE_CRASHED', message: 'gone' },
          },
        }),
        reason: 'crashed',
      })
      expect(useImageGenerationStore.getState()).toMatchObject({
        lastError: { code: 'ENGINE_CRASHED' },
        lastErrorModality: 'video',
      })
    })

    it('adopts a resident video model on bind', async () => {
      resetImageGenerationForTests()
      fake.getStatus.mockResolvedValue(makeVideoLoadedStatus())
      await useImageGenerationStore.getState().bind()
      expect(useImageGenerationStore.getState().videoCapabilities?.fps).toBe(24)
      expect(useImageGenerationStore.getState().capabilities).toBeNull()
    })

    it('unloading a video model empties the video slot and files a refusal under Video', async () => {
      useImageGenerationStore.setState({
        status: makeVideoLoadedStatus(),
        videoCapabilities: makeVideoCapabilities(),
      })
      await useImageGenerationStore.getState().unloadModel()
      expect(useImageGenerationStore.getState().videoCapabilities).toBeNull()

      useImageGenerationStore.setState({ status: makeVideoLoadedStatus() })
      fake.unloadModel.mockRejectedValue({ code: 'JOB_BUSY', message: 'busy' })
      await useImageGenerationStore.getState().unloadModel()
      expect(useImageGenerationStore.getState()).toMatchObject({
        lastError: { code: 'JOB_BUSY' },
        lastErrorModality: 'video',
      })
    })

    it('removing a video checkpoint clears the Video selection, not the image one', async () => {
      useImageSetting.setState({ selectedArtifactId: 'z-image:q4_k_m' })
      useVideoSetting.setState({ selectedArtifactId: LTX_Q4_ID })
      fake.listModelFiles.mockResolvedValue([])
      await useImageGenerationStore.getState().removeArtifact(LTX_Q4_ID)
      expect(useVideoSetting.getState().selectedArtifactId).toBeNull()
      expect(useImageSetting.getState().selectedArtifactId).toBe('z-image:q4_k_m')
    })

    it('sends the video folder with every configure and drops both folders when one is unusable', async () => {
      const { configureDiffusion } = await import('@/lib/diffusion/config')
      const configure = vi.mocked(configureDiffusion)
      useImageSetting.setState({ outputDir: '/pictures' })
      useVideoSetting.setState({ outputDir: '/movies' })
      configure.mockClear()
      await useImageGenerationStore.getState().applyIdleSettings()
      expect(configure.mock.calls.at(-1)?.[0]).toEqual({
        idleUnloadSecs: 600,
        outputDir: '/pictures',
        videoOutputDir: '/movies',
      })

      configure.mockClear()
      configure.mockRejectedValueOnce({ code: 'INTERNAL', message: 'mkdir' })
      await useImageGenerationStore.getState().applyIdleSettings()
      expect(configure.mock.calls).toEqual([
        [{ idleUnloadSecs: 600, outputDir: '/pictures', videoOutputDir: '/movies' }],
        [{ idleUnloadSecs: 600 }],
      ])
      expect(useImageSetting.getState().outputDir).toBe('/pictures')
      expect(useVideoSetting.getState().outputDir).toBe('/movies')
      expect(useImageGenerationStore.getState().lastError).toBeNull()

      // Only the video folder stored: the same fallback.
      useImageSetting.setState({ outputDir: null })
      configure.mockClear()
      configure.mockRejectedValueOnce({ code: 'DISK_FULL', message: 'full' })
      await useImageGenerationStore.getState().applyIdleSettings()
      expect(configure.mock.calls).toEqual([
        [{ idleUnloadSecs: 600, videoOutputDir: '/movies' }],
        [{ idleUnloadSecs: 600 }],
      ])
    })
  })
})

describe('engine updates', () => {
  let fake: FakeDiffusion
  const NEWER = 'master-900-abc1234'

  beforeEach(() => {
    relay.handlers.clear()
    resetImageGenerationForTests()
    useEngineVersionsStore.getState().reset()
    engines.updateEngine.mockReset()
    engines.engineVersions.mockReset()
    engines.engineVersions.mockResolvedValue(sdVersions(null))
    fake = makeFakeDiffusion()
    seedServiceHub({ diffusion: fake })
    useImageGenerationStore.setState({
      status: makeStatus(),
      hostBackendId: 'macos-arm64',
    })
  })

  it('finds nothing when the core offers no update', async () => {
    await useImageGenerationStore.getState().checkEngineUpdate()
    const { engineUpdate } = useImageGenerationStore.getState()
    expect(engineUpdate.availableTag).toBeNull()
    expect(engineUpdate.checkedAt).not.toBeNull()
    expect(engines.engineVersions).toHaveBeenCalledWith(
      expect.not.objectContaining({ force: true })
    )
  })

  it('reads the answer the app already holds instead of asking the core again', async () => {
    useEngineVersionsStore.setState({
      engines: { 'sd-cpp': sdVersions(NEWER).engines[0] },
    })

    await useImageGenerationStore.getState().checkEngineUpdate()

    expect(engines.engineVersions).not.toHaveBeenCalled()
    expect(useImageGenerationStore.getState().engineUpdate.availableTag).toBe(NEWER)
  })

  it('reports the build the core offers; the button asks it to re-read every source', async () => {
    engines.engineVersions.mockResolvedValue(sdVersions(NEWER))
    await useImageGenerationStore.getState().checkEngineUpdate({ force: true })
    expect(engines.engineVersions).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true })
    )
    expect(useImageGenerationStore.getState().engineUpdate.availableTag).toBe(
      NEWER
    )
  })

  it('says why when the core could not read the engine’s source', async () => {
    engines.engineVersions.mockResolvedValue({
      engines: [
        {
          ...sdVersions(null).engines[0],
          error: {
            code: 'UPSTREAM_ERROR',
            message: 'The sd-cpp manifest is unavailable.',
          },
        },
      ],
    })
    await useImageGenerationStore.getState().checkEngineUpdate()
    const { engineUpdate } = useImageGenerationStore.getState()
    expect(engineUpdate.error).toBe('The sd-cpp manifest is unavailable.')
    expect(engineUpdate.availableTag).toBeNull()
  })

  it('updates through the core, leaving the unload to it, and clears the offer', async () => {
    useImageGenerationStore.setState({
      status: makeLoadedStatus(),
      capabilities: makeCapabilities(),
      engineUpdate: {
        checking: false,
        availableTag: NEWER,
        checkedAt: 1,
        error: null,
      },
    })
    let during: string | null = null
    engines.updateEngine.mockImplementation(async () => {
      during = useImageGenerationStore.getState().engineUpdatingTo
      return updated(NEWER)
    })
    await useImageGenerationStore.getState().updateEngine()

    expect(fake.unloadModel).not.toHaveBeenCalled()
    expect(fake.installEngine).not.toHaveBeenCalled()
    expect(engines.updateEngine).toHaveBeenCalledWith('sd-cpp', {
      task_id: `diffusion-backend-${NEWER}-macos-arm64`,
      app_version: 'test',
    })
    expect(during).toBe(NEWER)
    const state = useImageGenerationStore.getState()
    expect(state.engineUpdatingTo).toBeNull()
    expect(state.engineUpdate.availableTag).toBeNull()
  })

  it('keeps the offer and says why when the update fails', async () => {
    useImageGenerationStore.setState({
      engineUpdate: {
        checking: false,
        availableTag: NEWER,
        checkedAt: 1,
        error: null,
      },
    })
    engines.updateEngine.mockRejectedValue({
      code: 'ENGINE_INSTALL_FAILED',
      message: 'Could not download the engine.',
    })
    await useImageGenerationStore.getState().updateEngine()

    const state = useImageGenerationStore.getState()
    expect(state.engineUpdatingTo).toBeNull()
    expect(state.engineUpdate.availableTag).toBe(NEWER)
    expect(state.lastError?.code).toBe('ENGINE_INSTALL_FAILED')
  })

  it('does nothing without an offer or an installed engine', async () => {
    captured.events.length = 0
    await useImageGenerationStore.getState().updateEngine()
    expect(engines.updateEngine).not.toHaveBeenCalled()
    expect(useImageGenerationStore.getState().engineInstall).toEqual({
      inFlight: false,
      transferred: 0,
      total: 0,
      error: null,
    })
    expect(captured.events).toEqual([])

    useImageGenerationStore.setState({
      status: makeStatus({ install: { state: 'not-installed' } }),
    })
    await useImageGenerationStore.getState().checkEngineUpdate()
    expect(engines.engineVersions).not.toHaveBeenCalled()
    expect(useImageGenerationStore.getState().engineUpdate).toEqual({
      checking: false,
      availableTag: null,
      checkedAt: null,
      error: null,
    })
  })

  it('publishes no offer of its own: the banner reads the core', async () => {
    engines.engineVersions.mockResolvedValue(sdVersions(NEWER))
    await useImageGenerationStore.getState().checkEngineUpdate()
    expect(
      Object.keys(localStorage).filter((key) =>
        key.startsWith('atomic_engine_update_offer_')
      )
    ).toEqual([])
  })
})
