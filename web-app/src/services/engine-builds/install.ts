/**
 * An engine-build install the core runs, shown in the download panel.
 *
 * The core downloads under the caller's task id and reports progress as its
 * `download:progress` events, which the relay also sends as the legacy
 * `download-<task_id>` the download extension has always listened to (the
 * same frames a llama.cpp backend install through the core uses). This turns
 * them into the panel's `DownloadEvent`s: a row from the first frame, closed
 * as finished, stopped (a cancel) or failed.
 */

import { listen } from '@tauri-apps/api/event'
import { DownloadEvent, events } from '@janhq/core'

import {
  emitTransferError,
  emitTransferProgress,
  emitTransferSuccess,
  sanitizeTaskId,
} from '@/services/diffusion/transfer'

import { engineBuildProxy, installEngineBuild } from './core'
import type {
  EngineBuildId,
  EngineBuildInstallRequest,
  EngineBuildInstallResult,
} from './types'

/** Row ids of engine builds other than sd.cpp, whose rows keep their `diffusion-backend-` name. */
export const ENGINE_BUILD_TASK_PREFIX = 'engine-build-'

/** `engine-build-<engine>-<tag>`; must satisfy Tauri's event-name alphabet. */
export function engineBuildTaskId(engine: EngineBuildId, tag: string): string {
  return `${ENGINE_BUILD_TASK_PREFIX}${engine}-${sanitizeTaskId(tag)}`
}

export function isEngineBuildTaskId(id: string): boolean {
  return id.startsWith(ENGINE_BUILD_TASK_PREFIX)
}

export type EngineBuildInstallOptions = {
  taskId: string
  /** Reinstall the same build. The core never installs one older than the active build. */
  force?: boolean
  onProgress?: (progress: { transferred: number; total: number }) => void
  /** The call that starts the install; the core's route by default. */
  install?: (request: EngineBuildInstallRequest) => Promise<EngineBuildInstallResult>
}

const isCancelled = (error: unknown): boolean =>
  (error as { code?: unknown } | null | undefined)?.code === 'CANCELLED'

const describe = (error: unknown): string => {
  if (error instanceof Error) return error.message
  const message = (error as { message?: unknown } | null | undefined)?.message
  return typeof message === 'string' ? message : String(error)
}

/**
 * Install `engine` through the core under `taskId`. Rejects with the core's
 * error as it came (`{code, message, details?}`).
 */
export async function installEngineBuildWithProgress(
  engine: EngineBuildId,
  options: EngineBuildInstallOptions
): Promise<EngineBuildInstallResult> {
  const { taskId } = options
  const proxy = engineBuildProxy()
  const install =
    options.install ??
    ((request: EngineBuildInstallRequest) => installEngineBuild(engine, request))

  // A resumed transfer and a companion archive restart the core's counters;
  // the bar must never move backwards.
  let transferred = 0
  let total = 0
  let reported = false
  const report = (bytes: number, size: number) => {
    reported = true
    transferred = Math.max(transferred, bytes)
    total = Math.max(total, size, transferred)
    options.onProgress?.({ transferred, total })
    emitTransferProgress(taskId, 'Backend', transferred, total)
  }
  // Registered before the call: the core reports progress before it answers.
  const unlisten = await listen<{
    transferred: number
    total: number
    stage?: unknown
  }>(`download-${taskId}`, (event) => {
    const { stage } = event.payload
    if (stage) {
      // A status frame (connecting, retrying n/m) with zeroed counters.
      if (!reported) report(0, 0)
      events.emit(DownloadEvent.onFileDownloadUpdate, {
        modelId: taskId,
        downloadType: 'Backend',
        stage,
      })
      return
    }
    report(event.payload.transferred, event.payload.total)
  })
  try {
    const result = await install({
      task_id: taskId,
      ...(options.force ? { force: true } : {}),
      ...(proxy ? { proxy } : {}),
    })
    // Nothing was downloaded for `installed: false`, and no row was opened.
    if (reported) emitTransferSuccess(taskId, 'Backend', total)
    return result
  } catch (error) {
    if (isCancelled(error)) {
      events.emit(DownloadEvent.onFileDownloadStopped, {
        modelId: taskId,
        downloadType: 'Backend',
      })
    } else {
      emitTransferError(taskId, 'Backend', describe(error))
    }
    throw error
  } finally {
    unlisten()
  }
}
