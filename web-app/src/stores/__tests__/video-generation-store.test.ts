import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

import {
  makeFakeDiffusion,
  makeStatus,
  type FakeDiffusion,
} from '@/lib/diffusion/__tests__/image-fixtures'
import {
  makeVideoCapabilities,
  makeVideoItem,
  makeVideoJob,
  makeVideoLoadedStatus,
  makeVideoRequest,
} from '@/lib/diffusion/__tests__/video-fixtures'
import { seedServiceHub } from '@/test/service-hub'

const poster = vi.hoisted(() => ({
  capture: vi.fn(async (_path: string) => 'UE5H'),
}))
vi.mock('@/lib/video/poster', async (importOriginal) => ({
  ...(await importOriginal<typeof import('@/lib/video/poster')>()),
  capturePosterForClip: poster.capture,
}))
const notifications = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/lib/notifications', () => ({
  notifyThreadCompleted: notifications.notify,
}))
const captured = vi.hoisted(() => ({
  events: [] as Array<[string, Record<string, unknown>]>,
}))
vi.mock('@/lib/telemetry-queue', () => ({
  queuedCapture: vi.fn((event: string, props: Record<string, unknown>) => {
    captured.events.push([event, props])
  }),
}))

import { useImageGenerationStore } from '../image-generation-store'
import { useVideoGalleryStore } from '../video-gallery-store'
import {
  resetVideoGenerationForTests,
  useVideoGenerationStore,
} from '../video-generation-store'

/** Emit after the store has registered its waiter (a macrotask later). */
const emitLater = (
  fake: FakeDiffusion,
  event: () => Parameters<FakeDiffusion['emit']>[0]
) => setTimeout(() => fake.emit(event()), 0)

const flush = () => new Promise((resolve) => setTimeout(resolve, 0))

describe('video-generation-store', () => {
  let fake: FakeDiffusion

  beforeEach(async () => {
    vi.useRealTimers()
    captured.events.length = 0
    poster.capture.mockClear()
    poster.capture.mockResolvedValue('UE5H')
    notifications.notify.mockClear()
    resetVideoGenerationForTests()
    useVideoGalleryStore.getState().reset()
    fake = makeFakeDiffusion()
    fake.setVideoPoster.mockImplementation(async (id) =>
      makeVideoItem({ id, posterPath: `/data/videos/${id}.thumb.png` })
    )
    seedServiceHub({ diffusion: fake })
    useImageGenerationStore.getState().reset()
    useImageGenerationStore.setState({
      status: makeVideoLoadedStatus(),
      videoCapabilities: makeVideoCapabilities(),
    })
    await useVideoGenerationStore.getState().bind()
  })

  afterEach(() => {
    vi.useRealTimers()
  })

  describe('one clip per Generate', () => {
    it('submits, follows progress, lands the clip, gives it a poster and reports without the prompt', async () => {
      const item = makeVideoItem({ id: 'vjob-1', posterPath: null })
      fake.generateVideo.mockImplementation(async (request) => {
        emitLater(fake, () => ({
          type: 'video-progress',
          jobId: 'vjob-1',
          progress: {
            phase: 'sampling',
            step: 4,
            totalSteps: 8,
            fraction: 0.5,
            etaSeconds: 3,
            elapsedMs: 3_000,
          },
        }))
        setTimeout(
          () =>
            fake.emit({
              type: 'video-job',
              job: makeVideoJob({
                id: 'vjob-1',
                state: 'completed',
                request,
                outputs: [item],
              }),
            }),
          1
        )
        return { jobId: 'vjob-1' }
      })
      const focus = vi.spyOn(document, 'hasFocus').mockReturnValue(false)

      const run = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: 42,
      })
      expect(useVideoGenerationStore.getState()).toMatchObject({
        generating: true,
        stopRequested: false,
        lastError: null,
      })
      expect(useVideoGalleryStore.getState().viewerMode).toBe('live')
      await run

      expect(fake.generateVideo).toHaveBeenCalledWith({
        ...makeVideoRequest(),
        seed: 42,
      })
      const state = useVideoGenerationStore.getState()
      expect(state).toMatchObject({
        generating: false,
        currentJob: null,
        generationStartedAtMs: null,
      })
      expect(useVideoGalleryStore.getState().items.map((i) => i.id)).toEqual(['vjob-1'])
      expect(useVideoGalleryStore.getState().selectedId).toBe('vjob-1')

      await waitFor(() =>
        expect(useVideoGalleryStore.getState().items[0].posterPath).toBe(
          '/data/videos/vjob-1.thumb.png'
        )
      )
      expect(poster.capture).toHaveBeenCalledWith('/data/videos/vjob-1.webm')
      expect(fake.setVideoPoster).toHaveBeenCalledWith('vjob-1', 'UE5H')

      expect(captured.events).toEqual([
        [
          'video_generate',
          {
            generate_status: 'completed',
            model_family: 'ltx-2',
            quant: 'q4_k_m',
            engine: 'sd-cpp',
            backend: 'metal',
            width: 768,
            height: 512,
            frames: 49,
            fps: 24,
            steps: 8,
            duration_ms: 65_000,
            error_code: null,
          },
        ],
      ])
      expect(JSON.stringify(captured.events)).not.toContain('lighthouse')
      expect(JSON.stringify(captured.events)).not.toContain('42')
      expect(notifications.notify).toHaveBeenCalledWith(
        'videos:notifications.readyTitle',
        'videos:notifications.readyBody'
      )
      focus.mockRestore()
    })

    it('shows the progress of the running job and marks it generating', async () => {
      fake.generateVideo.mockImplementation(async () => {
        emitLater(fake, () => ({
          type: 'video-progress',
          jobId: 'vjob-1',
          progress: {
            phase: 'sampling',
            step: 2,
            totalSteps: 8,
            fraction: 0.25,
            etaSeconds: null,
            elapsedMs: 100,
          },
        }))
        return { jobId: 'vjob-1' }
      })
      const run = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      await flush()
      await flush()
      expect(useVideoGenerationStore.getState().currentJob).toMatchObject({
        id: 'vjob-1',
        state: 'generating',
        progress: { phase: 'sampling', step: 2 },
      })
      expect(fake.generateVideo.mock.calls[0][0]).not.toHaveProperty('seed')
      fake.emit({
        type: 'video-job',
        job: makeVideoJob({ id: 'vjob-1', state: 'cancelled' }),
      })
      await run
      expect(useVideoGenerationStore.getState().lastError?.code).toBeUndefined()
    })

    it('refuses a request the loaded model cannot take before touching the core', async () => {
      await useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest({ frames: 50 }),
        seed: null,
      })
      expect(fake.generateVideo).not.toHaveBeenCalled()
      expect(useVideoGenerationStore.getState()).toMatchObject({
        generating: false,
        lastError: { code: 'INVALID_REQUEST' },
      })
    })

    it('reports a refused submit as the last error and stops', async () => {
      fake.generateVideo.mockRejectedValue({ code: 'JOB_BUSY', message: 'busy' })
      await useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      expect(useVideoGenerationStore.getState()).toMatchObject({
        generating: false,
        generationStartedAtMs: null,
        lastError: { code: 'JOB_BUSY' },
      })
      expect(captured.events).toEqual([])
    })

    it('surfaces a failure, but not a cancel the user asked for', async () => {
      fake.generateVideo.mockImplementation(async () => {
        emitLater(fake, () => ({
          type: 'video-job',
          job: makeVideoJob({
            id: 'vjob-1',
            state: 'failed',
            error: { code: 'OUT_OF_MEMORY', message: 'no room' },
          }),
        }))
        return { jobId: 'vjob-1' }
      })
      await useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      expect(useVideoGenerationStore.getState().lastError).toEqual({
        code: 'OUT_OF_MEMORY',
        message: 'no room',
      })
      expect(captured.events[0][1]).toMatchObject({
        generate_status: 'failed',
        error_code: 'OUT_OF_MEMORY',
      })
      expect(notifications.notify).not.toHaveBeenCalled()
      useVideoGenerationStore.getState().clearError()
      expect(useVideoGenerationStore.getState().lastError).toBeNull()

      // Stop: the cancel goes to the core, and the cancelled job is not an error.
      fake.generateVideo.mockImplementation(async () => ({ jobId: 'vjob-2' }))
      const run = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      await flush()
      await useVideoGenerationStore.getState().stop()
      expect(fake.cancelVideoJob).toHaveBeenCalledWith('vjob-2')
      fake.emit({
        type: 'video-job',
        job: makeVideoJob({
          id: 'vjob-2',
          state: 'cancelled',
          error: { code: 'CANCELLED', message: 'stopped' },
        }),
      })
      await run
      expect(useVideoGenerationStore.getState().lastError).toBeNull()
      expect(captured.events.at(-1)?.[1]).toMatchObject({ generate_status: 'cancelled' })
    })

    it('ignores a second Generate while one clip is being made, and Stop with nothing running', async () => {
      fake.generateVideo.mockImplementation(async () => ({ jobId: 'vjob-1' }))
      const first = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      await flush()
      await useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      expect(fake.generateVideo).toHaveBeenCalledTimes(1)
      fake.emit({ type: 'video-job', job: makeVideoJob({ id: 'vjob-1', state: 'completed' }) })
      await first
      await useVideoGenerationStore.getState().stop()
      expect(fake.cancelVideoJob).not.toHaveBeenCalled()
      expect(useVideoGenerationStore.getState().stopRequested).toBe(true)
    })

    it('falls back to polling when the terminal event never arrives, and fails a forgotten job', async () => {
      vi.useFakeTimers()
      fake.generateVideo.mockImplementation(async () => ({ jobId: 'vjob-1' }))
      fake.getVideoJob.mockResolvedValueOnce(
        makeVideoJob({ id: 'vjob-1', state: 'generating' })
      )
      fake.getVideoJob.mockResolvedValueOnce(
        makeVideoJob({ id: 'vjob-1', state: 'completed', outputs: [makeVideoItem()] })
      )
      const done = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      await vi.advanceTimersByTimeAsync(2_100)
      expect(useVideoGenerationStore.getState().currentJob?.state).toBe('generating')
      await vi.advanceTimersByTimeAsync(2_100)
      await done
      expect(useVideoGalleryStore.getState().items).toHaveLength(1)

      fake.getVideoJob.mockRejectedValueOnce(new Error('ipc'))
      fake.getVideoJob.mockResolvedValueOnce(null)
      const gone = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      await vi.advanceTimersByTimeAsync(4_200)
      await gone
      expect(useVideoGenerationStore.getState().lastError?.code).toBe('JOB_NOT_FOUND')
    })

    it('records an error event for the running job only', async () => {
      fake.generateVideo.mockImplementation(async () => ({ jobId: 'vjob-1' }))
      const run = useVideoGenerationStore.getState().startGeneration({
        request: makeVideoRequest(),
        seed: null,
      })
      await flush()
      fake.emit({ type: 'error', jobId: 'other', code: 'ENGINE_CRASHED', message: 'x' })
      expect(useVideoGenerationStore.getState().lastError).toBeNull()
      fake.emit({ type: 'error', jobId: 'vjob-1', code: 'ENGINE_CRASHED', message: 'gone' })
      expect(useVideoGenerationStore.getState().lastError).toMatchObject({
        code: 'ENGINE_CRASHED',
        message: 'gone',
      })
      fake.emit({ type: 'video-job', job: makeVideoJob({ id: 'vjob-1', state: 'failed' }) })
      await run
    })
  })

  describe('jobs from elsewhere', () => {
    it('shows a clip made by a job this page did not start, with a poster, and never doubles its own', async () => {
      fake.emit({
        type: 'video-job',
        job: makeVideoJob({ id: 'outside-1', state: 'generating' }),
      })
      expect(useVideoGenerationStore.getState().currentJob?.id).toBe('outside-1')
      expect(useVideoGenerationStore.getState().generating).toBe(false)
      fake.emit({
        type: 'video-job',
        job: makeVideoJob({
          id: 'outside-1',
          state: 'completed',
          outputs: [makeVideoItem({ id: 'outside-1', posterPath: null })],
        }),
      })
      expect(useVideoGenerationStore.getState().currentJob).toBeNull()
      expect(useVideoGalleryStore.getState().items.map((i) => i.id)).toEqual(['outside-1'])
      await waitFor(() => expect(fake.setVideoPoster).toHaveBeenCalledWith('outside-1', 'UE5H'))

      fake.emit({ type: 'video-job', job: makeVideoJob({ id: 'outside-2', state: 'generating' }) })
      fake.emit({ type: 'video-job', job: makeVideoJob({ id: 'outside-2', state: 'failed' }) })
      expect(useVideoGenerationStore.getState().currentJob).toBeNull()
      expect(useVideoGalleryStore.getState().items).toHaveLength(1)
    })

    it('adopts a clip that was already being made on bind and lands it', async () => {
      resetVideoGenerationForTests()
      fake.getStatus.mockResolvedValue(
        makeStatus({
          activeVideoJob: makeVideoJob({ id: 'active', state: 'generating', startedAtMs: 500 }),
        })
      )
      await useVideoGenerationStore.getState().bind()
      expect(useVideoGenerationStore.getState()).toMatchObject({
        generating: true,
        generationStartedAtMs: 500,
        currentJob: { id: 'active' },
      })
      fake.emit({
        type: 'video-job',
        job: makeVideoJob({ id: 'active', state: 'completed', outputs: [makeVideoItem({ id: 'active' })] }),
      })
      await waitFor(() => expect(useVideoGenerationStore.getState().generating).toBe(false))
      expect(useVideoGalleryStore.getState().items[0].id).toBe('active')

      // A status the core cannot answer is logged, not fatal.
      resetVideoGenerationForTests()
      const error = vi.spyOn(console, 'error').mockImplementation(() => {})
      fake.getStatus.mockRejectedValueOnce(new Error('down'))
      await useVideoGenerationStore.getState().bind()
      expect(useVideoGenerationStore.getState().bound).toBe(true)
      expect(error).toHaveBeenCalled()
      error.mockRestore()
    })

    it('binds once, never on an unsupported build, and unbind drops the subscription', async () => {
      await useVideoGenerationStore.getState().bind()
      expect(fake.subscribe).toHaveBeenCalledTimes(1)
      useVideoGenerationStore.getState().unbind()
      fake.emit({ type: 'video-job', job: makeVideoJob({ id: 'x', state: 'generating' }) })
      expect(useVideoGenerationStore.getState().currentJob).toBeNull()

      resetVideoGenerationForTests()
      fake.isSupported.mockReturnValue(false)
      fake.subscribe.mockClear()
      await useVideoGenerationStore.getState().bind()
      expect(fake.subscribe).not.toHaveBeenCalled()
      fake.emit({ type: 'reset', generation: 2 })
      fake.emit({ type: 'state', status: makeStatus(), reason: 'idle' })
    })
  })

  describe('posters', () => {
    it('remembers a clip whose poster failed and does not ask again', async () => {
      const warn = vi.spyOn(console, 'warn').mockImplementation(() => {})
      poster.capture.mockRejectedValue(new Error('no frame'))
      const item = makeVideoItem({ id: 'old', posterPath: null })
      useVideoGenerationStore.getState().requestPoster(item)
      await waitFor(() =>
        expect(useVideoGenerationStore.getState().posterFailedIds).toEqual(['old'])
      )
      useVideoGenerationStore.getState().requestPoster(item)
      expect(poster.capture).toHaveBeenCalledTimes(1)
      // One with a poster already is never asked.
      useVideoGenerationStore.getState().requestPoster(makeVideoItem({ id: 'has' }))
      expect(poster.capture).toHaveBeenCalledTimes(1)
      warn.mockRestore()
    })
  })
})
