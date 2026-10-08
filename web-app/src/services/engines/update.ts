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

export type EngineUpdateOptions = {
  taskId: string
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
 */
export async function updateEngineWithProgress(
  engine: EngineId,
  options: EngineUpdateOptions
): Promise<EngineUpdateResult> {
  const proxy = engineBuildProxy()
  const result = await followCoreDownload(
    options.taskId,
    () =>
      updateEngine(engine, {
        task_id: options.taskId,
        ...(options.target ? { target: options.target } : {}),
        ...(options.force ? { force: true } : {}),
        ...(proxy ? { proxy } : {}),
        app_version: VERSION,
      }),
    options.onProgress
  )
  if (result.updated && result.active) {
    announceBackendSwitched(engine, result.active)
  }
  return result
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
