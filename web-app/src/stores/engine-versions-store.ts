import { listen, type UnlistenFn } from '@tauri-apps/api/event'
import { create } from 'zustand'

import { createSafeUnlisten } from '@/lib/tauriEvent'
import { engineVersions } from '@/services/engines/core'
import { engineBuildProxy } from '@/services/engine-builds/core'
import type {
  EngineErrorBody,
  EngineId,
  EngineVersions,
} from '@/services/engines/types'

/**
 * The app's copy of the core's answer about every engine of this host
 * (`POST /engines/versions`, spec `engine-lifecycle-desktop`): installed
 * builds, the active one, the newest and the update offer. The only source of
 * engine update offers and of the installed builds list; the app never
 * compares engine versions itself.
 *
 * Asked once the core is attached (bind, and the relay's snapshot on every
 * reattach), then whenever the core says something changed: `engine:changed`,
 * `environment:changed` and a `settings:changed` of `version_backend`. The
 * "Check for updates" buttons ask with `force`, which re-reads every source
 * from the network. One request at a time: calls made while one runs fold into
 * a single one after it, so the last answer held is never older than the last
 * trigger.
 */

export const ENGINE_CHANGED_EVENT = 'atomic-core://engine:changed'
const ENVIRONMENT_CHANGED_EVENT = 'atomic-core://environment:changed'
const SETTINGS_CHANGED_EVENT = 'atomic-core://settings:changed'
/** The relay's snapshot: a core generation attached. */
const CORE_SNAPSHOT_EVENT = 'atomic-core://snapshot'

type RefreshOptions = { force?: boolean }

type EngineVersionsState = {
  /** The last answer for each engine of this host; an engine the host lacks is absent. */
  engines: Partial<Record<EngineId, EngineVersions>>
  /** The last whole request's failure, cleared by the next answer; the engines above stay as they were. */
  error: EngineErrorBody | null
  /** A request is running. */
  loading: boolean
  /** Ask the core again; resolves once an answer at least as new as this call is held. */
  refresh: (options?: RefreshOptions) => Promise<void>
  /** Follow the core's events; returns the unsubscribe. */
  bind: () => () => void
  reset: () => void
}

/** The relay's rejection, or anything else a call threw, as `{code, message}`. */
function toError(error: unknown): EngineErrorBody {
  if (typeof error === 'object' && error !== null) {
    const { code, message, details } = error as Record<string, unknown>
    if (typeof code === 'string' && typeof message === 'string') {
      return {
        code,
        message,
        ...(typeof details === 'string' ? { details } : {}),
      }
    }
  }
  return {
    code: 'INTERNAL_ERROR',
    message: error instanceof Error ? error.message : String(error),
  }
}

/** The request running now, and the one the calls made meanwhile are folded into. */
let running: Promise<void> | null = null
let queued: {
  force: boolean
  promise: Promise<void>
  resolve: () => void
} | null = null

export const useEngineVersionsStore = create<EngineVersionsState>()((
  set,
  get
) => {
  const ask = async (force: boolean): Promise<void> => {
    set({ loading: true })
    try {
      const proxy = engineBuildProxy()
      const answer = await engineVersions({
        ...(force ? { force: true } : {}),
        ...(proxy ? { proxy } : {}),
        app_version: VERSION,
      })
      set({
        engines: Object.fromEntries(
          answer.engines.map((entry) => [entry.engine, entry])
        ),
        error: null,
      })
    } catch (error) {
      set({ error: toError(error) })
    }
  }

  const start = (force: boolean): Promise<void> => {
    const promise = ask(force).finally(() => {
      running = null
      const next = queued
      queued = null
      if (next) void start(next.force).then(next.resolve, next.resolve)
      else set({ loading: false })
    })
    running = promise
    return promise
  }

  return {
    engines: {},
    error: null,
    loading: false,

    refresh: (options = {}) => {
      const force = options.force === true
      if (!running) return start(force)
      if (queued) {
        queued.force ||= force
        return queued.promise
      }
      let resolve!: () => void
      const promise = new Promise<void>((done) => (resolve = done))
      queued = { force, promise, resolve }
      return promise
    },

    bind: () => {
      const refresh = () => void get().refresh()
      const pending: Promise<UnlistenFn>[] = [
        listen(CORE_SNAPSHOT_EVENT, refresh),
        listen(ENGINE_CHANGED_EVENT, refresh),
        listen(ENVIRONMENT_CHANGED_EVENT, refresh),
        listen<{ key?: unknown }>(SETTINGS_CHANGED_EVENT, (event) => {
          if (event.payload?.key === 'version_backend') refresh()
        }),
      ]
      // Not attached yet answers with an error; the snapshot asks again.
      refresh()

      let detached = false
      return () => {
        if (detached) return
        detached = true
        for (const promise of pending.splice(0)) {
          promise
            .then((unlisten) => createSafeUnlisten(unlisten)())
            .catch(() => {})
        }
      }
    },

    reset: () => {
      running = null
      queued = null
      set({ engines: {}, error: null, loading: false })
    },
  }
})

/** One engine's last answer, or `undefined` when the host has no such engine (or none came yet). */
export function selectEngineVersions(
  state: Pick<EngineVersionsState, 'engines'>,
  engine: EngineId
): EngineVersions | undefined {
  return state.engines[engine]
}
