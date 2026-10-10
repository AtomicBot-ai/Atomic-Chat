/**
 * An engine update or a build switch the core applies (`POST
 * /engines/:engine/update`, `…/builds/:version/:variant/activate`). The app
 * never writes `version_backend`, unloads models or removes builds itself: the
 * core does all three under one lock (spec `engine-lifecycle-desktop`).
 *
 * An update downloads under `engine-update-<engine>-<version>`, shown in the
 * download panel; the core stops it on `POST /downloads/:id/cancel`. Once a
 * llama.cpp provider is on another build, `app:backend-hotswapped` goes out as
 * the extensions used to send it, so the switch dialog, the provider page and
 * the "waiting for restart" pill keep working unchanged.
 */

import { AppEvent, events } from '@janhq/core'

import { sanitizeTaskId } from '@/services/diffusion/transfer'
import { engineBuildProxy } from '@/services/engine-builds/core'
import { followCoreDownload } from '@/services/engine-builds/install'

import { activateEngineBuild, updateEngine } from './core'
import {
  ENGINE_KINDS,
  type EngineActivateResult,
  type EngineBuildKey,
  type EngineId,
  type EngineUpdateResult,
} from './types'

export const ENGINE_UPDATE_TASK_PREFIX = 'engine-update-'

/** `engine-update-<engine>-<version>`; must satisfy Tauri's event-name alphabet. */
export function engineUpdateTaskId(engine: EngineId, version: string): string {
  return `${ENGINE_UPDATE_TASK_PREFIX}${engine}-${sanitizeTaskId(version)}`
}

export function isEngineUpdateTaskId(id: string): boolean {
  return id.startsWith(ENGINE_UPDATE_TASK_PREFIX)
}

export const BACKEND_HOTSWAPPED_EVENT = 'app:backend-hotswapped'

/** Tell the app a llama.cpp provider now loads from `active`. */
function announceBackendSwitched(engine: EngineId, active: EngineBuildKey) {
  if (ENGINE_KINDS[engine] !== 'llamacpp') return
  window.dispatchEvent(
    new CustomEvent(BACKEND_HOTSWAPPED_EVENT, {
      detail: {
        backend: `${active.version}/${active.variant}`,
        provider: engine,
        version: active.version,
        backendId: active.variant,
      },
    })
  )
}

const isLlamacpp = (engine: EngineId) => ENGINE_KINDS[engine] === 'llamacpp'

/**
 * Where each llama.cpp extension persists its better-backend recommendation.
 * Applying any build drops it, as the extensions did after their own download:
 * otherwise a restart during onboarding offers the build already running.
 */
const RECOMMENDATION_KEYS: Partial<Record<EngineId, string>> = {
  'llamacpp-upstream': 'llama_cpp_better_backend_recommendation',
  'llamacpp': 'turboquant_better_backend_recommendation',
  'atomic-prism': 'atomic_prism_better_backend_recommendation',
}

function forgetRecommendation(engine: EngineId) {
  const key = RECOMMENDATION_KEYS[engine]
  if (!key) return
  try {
    localStorage.removeItem(key)
  } catch {
    // Storage unavailable: nothing was persisted either.
  }
}

export type EngineUpdateOptions = {
  taskId: string
  /**
   * What the backend dialog knows this switch by (`<version>/<variant>`, or a
   * `latest/<variant>` pick); the target's own pair by default.
   */
  backend?: string
  /** llama.cpp only: the build to move to; without `version`, the newest of the variant. */
  target?: { version?: string; variant: string }
  /** Reinstall a target already on disk. */
  force?: boolean
  onProgress?: (progress: { transferred: number; total: number }) => void
}

/**
 * Update a llama.cpp, sd.cpp or MLX engine through the core and show the
 * download. Resolves with the core's answer once the new build is active (or
 * nothing changed); rejects with the core's error as it came.
 *
 * For a llama.cpp provider the backend dialog hears the download start (on
 * the first progress frame) and finish (`AppEvent.onBackendDownloadStarted/
 * Finished`), then the switch (`app:backend-hotswapped`) — in that order: the
 * finish arms its "restart required" fallback, which the switch right after
 * closes. A build already on disk is only a switch; an answer that changed
 * nothing (`already-active`, `no-update`) is reported as nothing.
 */
export async function updateEngineWithProgress(
  engine: EngineId,
  options: EngineUpdateOptions
): Promise<EngineUpdateResult> {
  const proxy = engineBuildProxy()
  const target = options.target
  const backend =
    options.backend ??
    (target ? `${target.version ?? 'latest'}/${target.variant}` : engine)
  const [version, backendId] = backend.split('/')
  const announce = (status?: 'completed' | 'failed', error?: string) => {
    if (!isLlamacpp(engine)) return
    events.emit(
      status
        ? AppEvent.onBackendDownloadFinished
        : AppEvent.onBackendDownloadStarted,
      {
        backend,
        status: status ?? 'downloading',
        ...(error ? { error } : {}),
        provider: engine,
        version,
        backendId,
      }
    )
  }

  let downloading = false
  let result: EngineUpdateResult
  try {
    result = await followCoreDownload(
      options.taskId,
      () =>
        updateEngine(engine, {
          task_id: options.taskId,
          ...(target ? { target } : {}),
          ...(options.force ? { force: true } : {}),
          ...(proxy ? { proxy } : {}),
          app_version: VERSION,
        }),
      (progress) => {
        if (!downloading) {
          downloading = true
          announce()
        }
        options.onProgress?.(progress)
      }
    )
  } catch (error) {
    const message = (error as { message?: unknown } | null)?.message
    if (downloading) {
      announce('failed', typeof message === 'string' ? message : String(error))
    }
    throw error
  }
  if (downloading) announce('completed')
  if (result.updated && result.active) {
    if (isLlamacpp(engine)) forgetRecommendation(engine)
    announceBackendSwitched(engine, result.active)
  }
  return result
}

/**
 * Move a llama.cpp provider to `backend`: a `<version>/<variant>` it may
 * already have, or a `latest/<variant>` pick — the newest build of that
 * variant the core's catalog names. The core downloads what is missing,
 * switches and unloads the provider's models.
 */
export function switchBackendThroughCore(
  engine: EngineId,
  backend: string,
  options: Pick<EngineUpdateOptions, 'onProgress'> & {
    /** What the backend dialog opened on, when not `backend` itself (a `latest/` pick). */
    announceAs?: string
  } = {}
): Promise<EngineUpdateResult> {
  const [version, variant, ...rest] = backend
    .replace(/\uFEFF/g, '')
    .trim()
    .split('/')
  if (!version || !variant || rest.length > 0) {
    return Promise.reject(
      new Error(`Not a backend: "${backend}". Expected "<version>/<variant>".`)
    )
  }
  const latest = version === 'latest'
  return updateEngineWithProgress(engine, {
    taskId: engineUpdateTaskId(engine, latest ? `latest-${variant}` : version),
    target: latest ? { variant } : { version, variant },
    backend: options.announceAs ?? backend,
    onProgress: options.onProgress,
  })
}

/** Make an installed llama.cpp build the active one through the core. */
export async function activateEngineBuildThroughCore(
  engine: EngineId,
  version: string,
  variant: string
): Promise<EngineActivateResult> {
  const result = await activateEngineBuild(engine, version, variant)
  if (result.activated) announceBackendSwitched(engine, result.active)
  return result
}
