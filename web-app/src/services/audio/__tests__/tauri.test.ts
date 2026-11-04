import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'
import type { InvokeArgs } from '@tauri-apps/api/core'

import { QWEN_WIRE, makeJob } from '@/lib/audio/__tests__/audio-fixtures'

// The official IPC mock swallows `plugin:event|unlisten`, so events are
// observed by stubbing the event module itself.
const listen = vi.fn()
vi.mock('@tauri-apps/api/event', () => ({
  listen: (...args: unknown[]) => listen(...args),
}))

const { TauriAudioService, AUDIO_EVENT_MAP, AUDIO_RESET_EVENT } = await import(
  '../tauri'
)
const { DefaultAudioService, AUDIO_UNSUPPORTED } = await import('../default')
type AudioEvent = import('../types').AudioEvent

type Call = { method: string; path: string; body: unknown }

function recordCalls(answer: (call: Call) => unknown = () => ({})): Call[] {
  const calls: Call[] = []
  mockIPC((command, payload) => {
    if (command !== 'atomic_core_call') return undefined
    const call = payload as unknown as Call & InvokeArgs
    calls.push({ method: call.method, path: call.path, body: call.body })
    return answer(call)
  })
  return calls
}

describe('TauriAudioService', () => {
  const service = new TauriAudioService()

  it('reaches every route under /audio in the method the core serves', async () => {
    const calls = recordCalls((call) =>
      call.path === '/audio/model-files' && call.method === 'GET'
        ? { files: [] }
        : call.path.startsWith('/audio/jobs/') && call.method === 'GET'
          ? { job: null }
          : {}
    )

    await service.getStatus()
    await service.configure({ idleUnloadSecs: 0 })
    await service.setOutputDir('/music')
    await service.listModelFiles()
    await service.deleteModelFile('a.gguf')
    await service.unloadModel()
    await service.touchIdle()
    await service.getCapabilities()
    await service.getJob('job 1')
    await service.cancelJob('job 1')
    await service.listGallery({ offset: 50, limit: 25 })
    await service.deleteGalleryItem('job-1')

    expect(calls).toEqual([
      { method: 'GET', path: '/audio/status', body: null },
      { method: 'PUT', path: '/audio/config', body: { idleUnloadSecs: 0 } },
      { method: 'PUT', path: '/audio/output-dir', body: { path: '/music' } },
      { method: 'GET', path: '/audio/model-files', body: null },
      {
        method: 'DELETE',
        path: '/audio/model-files',
        body: { relativePath: 'a.gguf' },
      },
      { method: 'POST', path: '/audio/model/unload', body: null },
      { method: 'POST', path: '/audio/idle/touch', body: null },
      { method: 'GET', path: '/audio/capabilities', body: null },
      { method: 'GET', path: '/audio/jobs/job%201', body: null },
      { method: 'POST', path: '/audio/jobs/job%201/cancel', body: null },
      { method: 'GET', path: '/audio/gallery?offset=50&limit=25', body: null },
      { method: 'DELETE', path: '/audio/gallery/job-1', body: null },
    ])
  })

  it('loads a model with the request as the body', async () => {
    const calls = recordCalls()
    const request = {
      modelId: QWEN_WIRE,
      displayName: 'Qwen3-TTS 1.7B',
      mode: 'speech' as const,
      file: 'model.gguf',
      family: 'qwen3_tts',
      task: 'tts' as const,
      defaultVoice: 'vivian',
    }

    await service.loadModel(request)

    expect(calls).toEqual([
      { method: 'POST', path: '/audio/model/load', body: request },
    ])
  })

  it('submits a job as {mode, request} and answers it at once', async () => {
    const job = makeJob({ id: 'job-9' })
    const calls = recordCalls(() => job)

    const answer = await service.generate('music', {
      text: 'Warm chords',
      durationSec: 10,
    })

    expect(answer).toEqual(job)
    expect(calls[0].body).toEqual({
      mode: 'music',
      request: { text: 'Warm chords', durationSec: 10 },
    })
  })

  it('unwraps the routes that wrap their answer', async () => {
    const files = [{ path: '/a', relativePath: 'a', bytes: 1 }]
    const job = makeJob()
    recordCalls((call) =>
      call.path === '/audio/model-files' ? { files } : { job }
    )

    await expect(service.listModelFiles()).resolves.toEqual(files)
    await expect(service.getJob('job-1')).resolves.toEqual(job)
  })

  it('installs through the engine-build routes under audio-cpp', async () => {
    const calls = recordCalls()

    await service.engineCatalog({ force: true })
    await service.installEngine({ task_id: 'engine-build-audio-cpp-v0_9_3' })
    await service.removeEngineBuild('v0.9.3', 'macos-arm64')

    expect(calls.map(({ method, path }) => `${method} ${path}`)).toEqual([
      'POST /engine-builds/audio-cpp/catalog',
      'POST /engine-builds/audio-cpp/install',
      'DELETE /engine-builds/audio-cpp/v0.9.3/macos-arm64',
    ])
  })

  it('hands a rejection on untouched', async () => {
    const refusal = { code: 'JOB_BUSY', message: 'Busy' }
    mockIPC(() => {
      throw refusal
    })

    await expect(service.cancelJob('job-1')).rejects.toEqual(refusal)
  })

  describe('subscribe', () => {
    beforeEach(() => listen.mockReset())

    it('relays state, job and error, and the core attaching as a reset', async () => {
      const relayed = new Map<string, (event: { payload: unknown }) => void>()
      listen.mockImplementation(async (name: string, handler) => {
        relayed.set(name, handler)
        return () => {}
      })
      const events: AudioEvent[] = []

      service.subscribe((event) => events.push(event))
      const job = makeJob()
      relayed.get('atomic-core://audio:job')?.({ payload: { job } })
      relayed.get('atomic-core://audio:error')?.({
        payload: { code: 'JOB_BUSY', message: 'Busy' },
      })
      relayed.get(AUDIO_RESET_EVENT)?.({ payload: { generation: 2 } })

      expect([...relayed.keys()].sort()).toEqual(
        [...Object.keys(AUDIO_EVENT_MAP), AUDIO_RESET_EVENT].sort()
      )
      expect(events).toEqual([
        { type: 'job', job },
        { type: 'error', code: 'JOB_BUSY', message: 'Busy' },
        { type: 'reset' },
      ])
    })

    it('detaches each listener once, also when asked twice', async () => {
      const unlisten = vi.fn()
      listen.mockImplementation(async () => unlisten)

      const detach = service.subscribe(() => {})
      detach()
      detach()
      await vi.waitFor(() =>
        expect(unlisten.mock.calls).toHaveLength(
          Object.keys(AUDIO_EVENT_MAP).length + 1
        )
      )
    })
  })
})

describe('DefaultAudioService', () => {
  const service = new DefaultAudioService()

  it('reads as empty off the desktop and refuses to act', async () => {
    expect(service.isSupported()).toBe(false)
    await expect(service.getStatus()).resolves.toMatchObject({
      install: { state: 'not-installed' },
      activeJob: null,
    })
    await expect(service.listModelFiles()).resolves.toEqual([])
    await expect(
      service.listGallery({ offset: 0, limit: 10 })
    ).resolves.toEqual({ items: [], hasMore: false, total: 0 })
    await expect(service.getJob('job-1')).resolves.toBeNull()
    await expect(service.generate('speech', { text: 'Hello' })).rejects.toThrow(
      AUDIO_UNSUPPORTED
    )
  })
})
