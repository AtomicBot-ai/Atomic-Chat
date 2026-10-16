/**
 * App-wide state for continuous sessions and schedules.
 *
 * Module-scoped (like the media job manager) so a running session keeps going
 * when the user navigates away from Media; the UI only subscribes. Schedules
 * are checked by a 30s ticker that runs while the app is open.
 */
import { create } from 'zustand'
import { ulid } from 'ulidx'

import { getServiceHub } from '@/hooks/useServiceHub'
import { coreMediaFileSystem, mediaDataFolder } from '@/stores/media-library-store'
import { materialize } from '@/services/media/assets'
import { isTerminalMediaJobState, type MediaJobEntry } from '@/services/media/jobManager'
import { createSessionStore } from '@/services/media/continuous/sessionStore'
import {
  advanceSchedules,
  createScheduleStore,
  type MediaSchedule,
} from '@/services/media/continuous/schedule'
import { runSession, type RunControl, type SessionRunnerDeps } from '@/services/media/continuous/runner'
import type { ContinuousSession } from '@/services/media/continuous/session'

const sessionStore = createSessionStore({ fs: coreMediaFileSystem, dataFolder: mediaDataFolder })
const scheduleStore = createScheduleStore({ fs: coreMediaFileSystem, dataFolder: mediaDataFolder })

export const SCHEDULE_TICK_MS = 30_000

type State = {
  sessions: ContinuousSession[]
  schedules: MediaSchedule[]
  loaded: boolean
  load: () => Promise<void>
  saveSession: (session: ContinuousSession, planMarkdown?: string) => Promise<void>
  removeSession: (id: string) => Promise<void>
  start: (id: string) => Promise<void>
  pause: (id: string) => void
  cancel: (id: string) => void
  isRunning: (id: string) => boolean
  addSchedule: (schedule: Omit<MediaSchedule, 'id' | 'created_at'>) => Promise<void>
  removeSchedule: (id: string) => Promise<void>
  readPlan: (id: string) => Promise<string | undefined>
}

const controls = new Map<string, RunControl>()
/** Sessions run one at a time: the GPU is one queue anyway. */
let chain: Promise<unknown> = Promise.resolve()

function waitForJob(clientJobId: string, signal: AbortSignal, manager: typeof import('@/services/media/jobManager').mediaJobManager) {
  return new Promise<MediaJobEntry>((resolve, reject) => {
    const check = () => {
      const entry = manager.get(clientJobId)
      if (entry && isTerminalMediaJobState(entry.state)) {
        unsubscribe()
        resolve(entry)
      }
    }
    const unsubscribe = manager.store.subscribe(check)
    signal.addEventListener('abort', () => {
      if (manager.canCancel(clientJobId)) void manager.cancel(clientJobId).catch(() => {})
      unsubscribe()
      reject(new DOMException('Session cancelled', 'AbortError'))
    })
    check()
  })
}

async function realDeps(): Promise<SessionRunnerDeps> {
  const { defaultChatGenerationDeps, resolveChatRequest } = await import('@/services/media/chatGeneration')
  const gen = await defaultChatGenerationDeps()
  let ffmpeg: boolean | undefined
  return {
    now: () => Date.now(),
    warn: (message, cause) => console.warn(`[continuous] ${message}`, cause),
    save: (session) => sessionStore.save(session),
    extractLastFrame: gen.extractLastFrame,
    async runStep(step, initImage, session, signal) {
      if (Object.keys(gen.capabilities()).length === 0) await gen.refresh()
      // Model + remembered settings come from the same resolver chat uses, so
      // resolution handling stays wherever that resolver puts it.
      const { request, model } = resolveChatRequest('text_to_video', step.prompt, gen)
      const params: Record<string, unknown> = {
        ...request.params,
        ...(session.base_params ?? {}),
        ...step.params,
        prompt: step.prompt,
      }
      if (step.length_seconds !== undefined) params.length_seconds = step.length_seconds
      if (step.fps !== undefined) params.fps = step.fps
      delete params.end_image
      if (initImage) params.init_image = initImage
      else delete params.init_image
      const finalRequest = { ...request, params }
      await gen.manager.submit(finalRequest)
      const entry = await waitForJob(finalRequest.client_job_id, signal, gen.manager)
      if (entry.state !== 'succeeded') {
        throw new Error(entry.error?.message ?? `The generation ${entry.state}.`)
      }
      const assets = await materialize(
        entry,
        { request: entry.request, model_label: model.label, app_version: gen.appVersion },
        gen.materializeDeps
      )
      const clip = assets.find((asset) => asset.media_type === 'video') ?? assets[0]
      if (!clip) throw new Error('The provider returned no output.')
      await gen.addToLibrary(assets)
      return { asset_id: clip.asset_id, path: clip.path, mime: clip.mime }
    },
    stitch: async (paths, session) => {
      const hub = getServiceHub().core()
      if (ffmpeg === undefined) ffmpeg = await hub.invoke<boolean>('media_ffmpeg_available').catch(() => false)
      if (!ffmpeg) throw new Error('ffmpeg was not found on PATH')
      const dir = await sessionStore.dirOf(session.id)
      const output = coreMediaFileSystem.join(dir, 'stitched.mp4')
      return hub.invoke<string>('media_stitch_videos', { inputs: paths, output })
    },
  }
}

export const useContinuousSessions = create<State>()((set, get) => {
  const replace = (session: ContinuousSession) =>
    set((state) => ({
      sessions: state.sessions.some((s) => s.id === session.id)
        ? state.sessions.map((s) => (s.id === session.id ? session : s))
        : [session, ...state.sessions],
    }))

  const fire = async (schedule: MediaSchedule) => {
    if (schedule.target.kind === 'session') {
      await get().start(schedule.target.session_id)
      return
    }
    const { generateMediaForChat, defaultChatGenerationDeps } = await import('@/services/media/chatGeneration')
    const target = schedule.target
    chain = chain.then(async () =>
      generateMediaForChat(target.task, target.prompt, await defaultChatGenerationDeps(), {}, {
        ...(target.length_seconds !== undefined ? { length_seconds: target.length_seconds } : {}),
      }).catch((error) => console.warn('[continuous] scheduled job failed', error))
    )
  }

  const tick = async () => {
    const { due, next } = advanceSchedules(get().schedules, Date.now())
    if (due.length === 0) return
    set({ schedules: next })
    await scheduleStore.save(next).catch((e) => console.warn('[continuous] schedules not saved', e))
    for (const schedule of due) await fire(schedule).catch((e) => console.warn('[continuous] schedule failed', e))
  }

  return {
    sessions: [],
    schedules: [],
    loaded: false,
    async load() {
      if (get().loaded) return
      const [sessions, schedules] = await Promise.all([sessionStore.list(), scheduleStore.load()])
      // A session that was running when the app closed is paused, not lost.
      set({
        sessions: sessions.map((s) => (s.status === 'running' ? { ...s, status: 'paused' as const } : s)),
        schedules,
        loaded: true,
      })
      setInterval(() => void tick(), SCHEDULE_TICK_MS)
      void tick()
    },
    async saveSession(session, planMarkdown) {
      replace(session)
      await sessionStore.save(session, planMarkdown)
    },
    async removeSession(id) {
      get().cancel(id)
      set((state) => ({ sessions: state.sessions.filter((s) => s.id !== id) }))
      await sessionStore.remove(id)
    },
    async start(id) {
      if (controls.has(id)) return
      const session = get().sessions.find((s) => s.id === id)
      if (!session) return
      replace({ ...session, status: 'scheduled' })
      const run = chain.then(async () => {
        const latest = get().sessions.find((s) => s.id === id)
        if (!latest || latest.status !== 'scheduled') return
        const control = runSession(latest, await realDeps(), replace)
        controls.set(id, control)
        try {
          await control.done
        } finally {
          controls.delete(id)
        }
      })
      chain = run.catch(() => {})
      await Promise.resolve()
    },
    pause(id) {
      const control = controls.get(id)
      if (control) control.pause()
      else {
        const s = get().sessions.find((x) => x.id === id)
        if (s?.status === 'scheduled') replace({ ...s, status: 'paused' })
      }
    },
    cancel(id) {
      const control = controls.get(id)
      if (control) control.cancel()
      else {
        const s = get().sessions.find((x) => x.id === id)
        if (s?.status === 'scheduled') replace({ ...s, status: 'cancelled' })
      }
    },
    isRunning: (id) => controls.has(id),
    async addSchedule(schedule) {
      const next = [...get().schedules, { ...schedule, id: ulid(), created_at: Date.now() }]
      set({ schedules: next })
      await scheduleStore.save(next)
    },
    async removeSchedule(id) {
      const next = get().schedules.filter((s) => s.id !== id)
      set({ schedules: next })
      await scheduleStore.save(next)
    },
    readPlan: (id) => sessionStore.readPlan(id),
  }
})
