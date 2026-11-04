import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'
import { waitFor } from '@testing-library/react'

import {
  ACE,
  MOSS,
  QWEN,
  QWEN_WIRE,
  SFX,
  SFX_WIRE,
  catalog,
  makeFakeAudio,
  makeEngineCatalog,
  makeFile,
  makeItem,
  makeJob,
  makeLoaded,
  makeLoadedStatus,
  makeStatus,
  missingRoute,
  type FakeAudio,
} from '@/lib/audio/__tests__/audio-fixtures'
import { seedServiceHub } from '@/test/service-hub'

const notifications = vi.hoisted(() => ({ notify: vi.fn() }))
vi.mock('@/lib/notifications', () => ({
  notifyUnlessWatching: notifications.notify,
}))
const registry = vi.hoisted(() => ({ fetch: vi.fn() }))
vi.mock('@/services/audio-catalog-registry', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/audio-catalog-registry')
  >()),
  fetchAudioCatalog: registry.fetch,
}))
const install = vi.hoisted(() => ({ run: vi.fn() }))
vi.mock('@/services/engine-builds/install', async (importOriginal) => ({
  ...(await importOriginal<
    typeof import('@/services/engine-builds/install')
  >()),
  installEngineBuildWithProgress: install.run,
}))

import { useAudioGenerationStore } from '../audio-generation-store'

const store = () => useAudioGenerationStore.getState()

/** Emit once the store has registered its waiter. */
const finishJob = (fake: FakeAudio, job: ReturnType<typeof makeJob>) =>
  setTimeout(() => fake.emit({ type: 'job', job }), 0)

const completed = (id = 'job-1') =>
  makeJob({ id, state: 'completed', output: makeItem(id) })

describe('audio-generation-store', () => {
  let fake: FakeAudio

  beforeEach(() => {
    vi.useRealTimers()
    notifications.notify.mockClear()
    install.run.mockReset()
    registry.fetch.mockReset()
    registry.fetch.mockResolvedValue({
      catalog: catalog(),
      source: 'baseline',
      fetchedAt: null,
    })
    fake = makeFakeAudio()
    seedServiceHub({ audio: fake })
    store().reset()
  })

  afterEach(() => {
    store().reset()
  })

  describe('on a core without audio', () => {
    beforeEach(() => {
      fake.getStatus.mockRejectedValue(missingRoute())
    })

    it('says so without an error and asks the core nothing more', async () => {
      await store().bind()

      expect(store().core).toBe('too-old')
      expect(store().lastError).toBeNull()
      expect(fake.listModelFiles).not.toHaveBeenCalled()
      expect(fake.listGallery).not.toHaveBeenCalled()
      expect(fake.engineCatalog).not.toHaveBeenCalled()
    })

    it('still lists the catalog’s models', async () => {
      await store().bind()

      expect(store().catalog.models).toHaveLength(4)
      expect(store().forms.speech.modelId).toBe(QWEN)
    })

    it('checks again when a new core attaches', async () => {
      await store().bind()
      fake.getStatus.mockResolvedValue(makeStatus())

      fake.emit({ type: 'reset' })

      await waitFor(() => expect(store().core).toBe('ready'))
      expect(fake.listGallery).toHaveBeenCalled()
    })
  })

  it('tells a core that did not answer from one that has no audio', async () => {
    fake.getStatus.mockRejectedValue({
      code: 'CORE_UNREACHABLE',
      message: 'No core',
    })

    await store().bind()

    expect(store().core).toBe('unreachable')
    expect(store().lastError).toBeNull()
  })

  it('binds once and reads what the page shows', async () => {
    fake.listModelFiles.mockResolvedValue([makeFile(QWEN)])
    fake.listGallery.mockResolvedValue({
      items: [makeItem('a'), makeItem('b')],
      hasMore: true,
      total: 60,
    })

    await store().bind()
    await store().bind()

    expect(fake.getStatus).toHaveBeenCalledTimes(1)
    expect(store()).toMatchObject({
      core: 'ready',
      hostBackendId: 'macos-arm64',
      hostBackendResolved: true,
      engineDownloadBytes: 60_000_000,
      galleryTotal: 60,
      galleryHasMore: true,
      selectedId: 'a',
    })
    expect(store().modelFiles).toHaveLength(1)
  })

  it('takes a manifest it could not read as no build, with the reason', async () => {
    fake.engineCatalog.mockResolvedValue(
      makeEngineCatalog({
        manifest: null,
        manifest_error: 'HTTP 404',
        host_backend_id: null,
        host_reason: 'No manifest',
      })
    )

    await store().bind()

    expect(store()).toMatchObject({
      hostBackendId: null,
      hostBackendReason: 'HTTP 404',
      hostBackendResolved: true,
    })
  })

  it('adopts a job that was running before the window opened', async () => {
    const running = makeJob({ id: 'job-7', state: 'generating' })
    fake.getStatus.mockResolvedValue(makeStatus({ activeJob: running }))

    await store().bind()

    expect(store()).toMatchObject({ generating: true, currentJob: running })

    fake.emit({ type: 'job', job: completed('job-7') })

    await waitFor(() => expect(store().generating).toBe(false))
    expect(store().selectedId).toBe('job-7')
  })

  describe('generate', () => {
    beforeEach(async () => {
      fake.listModelFiles.mockResolvedValue([makeFile(QWEN)])
      await store().bind()
    })

    it('loads the form’s model first, with the voice it needs', async () => {
      finishJob(fake, completed())

      await store().generate()

      expect(fake.loadModel).toHaveBeenCalledWith(
        expect.objectContaining({
          modelId: QWEN_WIRE,
          defaultVoice: 'vivian',
          file: 'qwen3-tts-12hz-1.7b-customvoice-q8_0.gguf',
        })
      )
      expect(fake.loadModel.mock.invocationCallOrder[0]).toBeLessThan(
        fake.generate.mock.invocationCallOrder[0]
      )
      expect(store().capabilities?.voices).toEqual(['vivian', 'uncle_fu'])
    })

    it('leaves a model that is already running alone', async () => {
      fake.getStatus.mockResolvedValue(makeLoadedStatus())
      await store().refreshStatus()
      finishJob(fake, completed())

      await store().generate()

      expect(fake.loadModel).not.toHaveBeenCalled()
      expect(store().selectedId).toBe('job-1')
    })

    it('swaps a model of another mode', async () => {
      fake.getStatus.mockResolvedValue(
        makeLoadedStatus(makeLoaded({ modelId: SFX_WIRE, mode: 'effects' }))
      )
      await store().refreshStatus()
      finishJob(fake, completed())

      await store().generate()

      expect(fake.loadModel).toHaveBeenCalledTimes(1)
      expect(store().capabilities?.modelId).toBe(QWEN_WIRE)
    })

    it('puts a finished clip on top of the gallery and in the player', async () => {
      useAudioGenerationStore.setState({
        gallery: [makeItem('old')],
        galleryTotal: 1,
        selectedId: 'old',
      })
      finishJob(fake, completed('job-1'))

      await store().generate()

      expect(store().gallery.map((clip) => clip.id)).toEqual(['job-1', 'old'])
      expect(store()).toMatchObject({
        selectedId: 'job-1',
        galleryTotal: 2,
        generating: false,
        currentJob: null,
      })
      expect(notifications.notify).toHaveBeenCalledTimes(1)
    })

    it('always sends a duration for effects', async () => {
      fake.listModelFiles.mockResolvedValue([makeFile(SFX)])
      await store().refreshModelFiles()
      store().setMode('effects')
      finishJob(fake, completed())

      await store().generate()

      expect(fake.generate).toHaveBeenCalledWith(
        'effects',
        expect.objectContaining({ durationSec: 5, seed: 42 })
      )
      expect(store().generating).toBe(false)
    })

    it('stops at a failed load, with the core’s code', async () => {
      fake.loadModel.mockRejectedValue({
        code: 'OUT_OF_MEMORY',
        message: 'Too big',
      })

      await store().generate()

      expect(fake.generate).not.toHaveBeenCalled()
      expect(store().lastError?.code).toBe('OUT_OF_MEMORY')
      expect(store().loadingModelId).toBeNull()
      expect(store().generating).toBe(false)
    })

    it('shows a refused submit', async () => {
      fake.generate.mockRejectedValue({
        code: 'JOB_BUSY',
        message: 'Busy',
      })

      await store().generate()

      expect(store().lastError?.code).toBe('JOB_BUSY')
      expect(store().generating).toBe(false)
    })

    it('shows a failed job with the engine’s words', async () => {
      const error = {
        code: 'REQUEST_REJECTED' as const,
        message: 'Refused',
        details: 'requires speaker',
      }
      finishJob(fake, makeJob({ state: 'failed', error }))

      await store().generate()

      expect(store().lastError).toEqual(error)
      expect(store().gallery).toEqual([])
    })

    it('ends a job the core no longer knows instead of waiting for ever', async () => {
      vi.useFakeTimers()
      fake.getJob.mockResolvedValue(null)

      const generating = store().generate()
      await vi.advanceTimersByTimeAsync(2100)
      await generating

      expect(store().lastError?.code).toBe('ENGINE_CRASHED')
      expect(store().generating).toBe(false)
    })

    it('stops a running job, and a cancel is no failure', async () => {
      fake.generate.mockResolvedValue(makeJob({ state: 'generating' }))
      const generating = store().generate()
      await waitFor(() => expect(store().currentJob).not.toBeNull())

      await store().stop()
      expect(store().stopRequested).toBe(true)
      expect(fake.cancelJob).toHaveBeenCalledWith('job-1')

      fake.emit({
        type: 'error',
        jobId: 'job-1',
        code: 'CANCELLED',
        message: 'Stopped',
      })
      fake.emit({
        type: 'job',
        job: makeJob({
          state: 'cancelled',
          error: { code: 'CANCELLED', message: 'Stopped' },
        }),
      })
      await generating

      expect(store().lastError).toBeNull()
      expect(store().gallery).toEqual([])
      expect(store().generating).toBe(false)
    })

    it('follows a job through its phases', async () => {
      fake.generate.mockResolvedValue(makeJob({ state: 'generating' }))
      const generating = store().generate()
      await waitFor(() => expect(store().currentJob).not.toBeNull())

      fake.emit({
        type: 'job',
        job: makeJob({
          state: 'generating',
          progress: { phase: 'saving', elapsedMs: 900 },
        }),
      })

      expect(store().currentJob?.progress?.phase).toBe('saving')
      fake.emit({ type: 'job', job: completed() })
      await generating
    })
  })

  describe('events', () => {
    beforeEach(async () => {
      await store().bind()
    })

    it('shows a clip made by another client', () => {
      fake.emit({ type: 'job', job: completed('api-clip') })

      expect(store().gallery.map((clip) => clip.id)).toEqual(['api-clip'])
      expect(store().galleryTotal).toBe(1)
    })

    it('reads the capabilities of a model another client loaded', async () => {
      fake.emit({ type: 'state', status: makeLoadedStatus() })

      await waitFor(() => expect(store().capabilities).not.toBeNull())
    })

    it('forgets the capabilities when the model goes', () => {
      useAudioGenerationStore.setState({
        capabilities: {
          modelId: QWEN_WIRE,
          mode: 'speech',
          family: 'qwen3_tts',
          task: 'tts',
          params: [],
          voices: [],
          supportsVoiceRef: false,
          requiresVoiceRef: false,
        },
      })

      fake.emit({ type: 'state', status: makeStatus() })

      expect(store().capabilities).toBeNull()
    })

    it('shows a model failure once: a dismissed banner stays dismissed', () => {
      const failed = makeStatus({
        model: {
          state: 'failed',
          loaded: null,
          error: { code: 'MODEL_LOAD_FAILED', message: 'No' },
        },
      })

      fake.emit({ type: 'state', status: failed })
      expect(store().lastError?.code).toBe('MODEL_LOAD_FAILED')

      store().clearError()
      fake.emit({ type: 'state', status: failed })
      expect(store().lastError).toBeNull()
    })

    it('leaves another job’s error to whoever ran it', () => {
      useAudioGenerationStore.setState({ currentJob: makeJob() })

      fake.emit({
        type: 'error',
        jobId: 'other',
        code: 'JOB_BUSY',
        message: 'Busy',
      })

      expect(store().lastError).toBeNull()
    })
  })

  describe('the form', () => {
    it('gives each mode its own settings', () => {
      store().changeForm({ prompt: 'Spoken' })
      store().setMode('music')
      store().changeForm({ prompt: 'Sung' })

      expect(store().forms.speech.prompt).toBe('Spoken')
      expect(store().forms.music.prompt).toBe('Sung')
    })

    it('takes a picked model’s numbers and keeps the words', () => {
      store().setMode('speech')
      store().changeForm({ prompt: 'Mine', seed: '7' })

      store().pickModel(MOSS)

      expect(store().forms.speech).toMatchObject({
        modelId: MOSS,
        prompt: 'Mine',
        seed: '42',
      })
    })

    it('ignores a model the catalog does not list', () => {
      store().pickModel('gone')

      expect(store().forms.speech.modelId).toBe(QWEN)
    })

    it('resets the mode in view', () => {
      store().setMode('music')
      store().pickModel(ACE)
      store().changeForm({ durationSec: 45, prompt: 'Mine' })

      store().resetForm()

      expect(store().forms.music).toMatchObject({
        durationSec: 10,
        prompt: 'Mine',
      })
    })
  })

  describe('models', () => {
    beforeEach(async () => {
      fake.listModelFiles.mockResolvedValue([makeFile(MOSS)])
      await store().bind()
    })

    it('deletes by the name relative to the models folder', async () => {
      fake.listModelFiles.mockResolvedValue([])

      await store().removeModel(MOSS)

      expect(fake.deleteModelFile).toHaveBeenCalledWith(
        'moss-tts-nano-100m-q8_0.gguf'
      )
      expect(fake.unloadModel).not.toHaveBeenCalled()
      expect(store().modelFiles).toEqual([])
    })

    it('stops the model first when it is the loaded one', async () => {
      fake.getStatus.mockResolvedValue(
        makeLoadedStatus(makeLoaded({ modelId: `${MOSS}:q8_0` }))
      )
      await store().refreshStatus()

      await store().removeModel(MOSS)

      expect(fake.unloadModel.mock.invocationCallOrder[0]).toBeLessThan(
        fake.deleteModelFile.mock.invocationCallOrder[0]
      )
    })

    it('shows a refused delete', async () => {
      fake.deleteModelFile.mockRejectedValue({
        code: 'BACKEND_IN_USE',
        message: 'In use',
      })

      await store().removeModel(MOSS)

      expect(store().lastError?.code).toBe('BACKEND_IN_USE')
    })
  })

  describe('the engine', () => {
    beforeEach(async () => {
      fake.getStatus.mockResolvedValue(
        makeStatus({ install: { state: 'not-installed' } })
      )
      await store().bind()
    })

    it('installs under the engine-build task id and reads the status again', async () => {
      install.run.mockResolvedValue({ installed: true })
      fake.getStatus.mockResolvedValue(makeStatus())

      await store().installEngine()

      expect(install.run).toHaveBeenCalledWith(
        'audio-cpp',
        expect.objectContaining({ taskId: 'engine-build-audio-cpp-v0_9_3' })
      )
      expect(store().status?.install.state).toBe('installed')
      expect(store().engineInstall).toMatchObject({
        inFlight: false,
        error: null,
      })
    })

    it('reads a full disk as the audio code', async () => {
      install.run.mockRejectedValue({
        code: 'BACKEND_INSUFFICIENT_DISK_SPACE',
        message: 'Full',
      })

      await store().installEngine()

      expect(store().engineInstall.error?.code).toBe('DISK_FULL')
    })

    it('takes a cancel from the panel as the user’s choice', async () => {
      install.run.mockRejectedValue({ code: 'CANCELLED', message: 'Stopped' })

      await store().installEngine()

      expect(store().engineInstall.error).toBeNull()
    })

    it('refuses before downloading on a computer with no build', async () => {
      fake.engineCatalog.mockResolvedValue(
        makeEngineCatalog({
          host_backend_id: null,
          host_reason: 'No Intel Mac build',
        })
      )

      await store().installEngine()

      expect(install.run).not.toHaveBeenCalled()
      expect(store().engineInstall.error).toMatchObject({
        code: 'UNSUPPORTED_BACKEND',
        message: 'No Intel Mac build',
      })
    })
  })

  describe('the gallery', () => {
    beforeEach(async () => {
      fake.listGallery.mockResolvedValue({
        items: [makeItem('a'), makeItem('b'), makeItem('c')],
        hasMore: true,
        total: 4,
      })
      await store().bind()
    })

    it('reads the next page after what it holds', async () => {
      fake.listGallery.mockResolvedValue({
        items: [makeItem('c'), makeItem('d')],
        hasMore: false,
        total: 4,
      })

      await store().loadMoreGallery()

      expect(fake.listGallery).toHaveBeenLastCalledWith({
        offset: 3,
        limit: 50,
      })
      expect(store().gallery.map((clip) => clip.id)).toEqual([
        'a',
        'b',
        'c',
        'd',
      ])
      expect(store().galleryHasMore).toBe(false)
    })

    it('moves to the neighbour when the selected clip is deleted', async () => {
      store().selectClip('b')

      await store().deleteClip('b')

      expect(fake.deleteGalleryItem).toHaveBeenCalledWith('b')
      expect(store().gallery.map((clip) => clip.id)).toEqual(['a', 'c'])
      expect(store().selectedId).toBe('c')
      expect(store().galleryTotal).toBe(3)
    })

    it('selects nothing when the last clip goes', async () => {
      useAudioGenerationStore.setState({
        gallery: [makeItem('a')],
        selectedId: 'a',
        galleryTotal: 1,
      })

      await store().deleteClip('a')

      expect(store().selectedId).toBeNull()
    })

    it('keeps the clip when the core refuses, for the dialog to report', async () => {
      fake.deleteGalleryItem.mockRejectedValue({
        code: 'INTERNAL',
        message: 'No',
      })

      await expect(store().deleteClip('a')).rejects.toMatchObject({
        code: 'INTERNAL',
      })
      expect(store().gallery).toHaveLength(3)
    })
  })
})
