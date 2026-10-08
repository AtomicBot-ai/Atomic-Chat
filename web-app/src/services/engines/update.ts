/**
 * An engine update the core applies (`POST /engines/:engine/update`), shown in
 * the download panel under `engine-update-<engine>-<version>`. The core
 * downloads under that task id and stops it on `POST /downloads/:id/cancel`.
 */

import { sanitizeTaskId } from '@/services/diffusion/transfer'

import type { EngineId } from './types'

export const ENGINE_UPDATE_TASK_PREFIX = 'engine-update-'

/** `engine-update-<engine>-<version>`; must satisfy Tauri's event-name alphabet. */
export function engineUpdateTaskId(engine: EngineId, version: string): string {
  return `${ENGINE_UPDATE_TASK_PREFIX}${engine}-${sanitizeTaskId(version)}`
}

export function isEngineUpdateTaskId(id: string): boolean {
  return id.startsWith(ENGINE_UPDATE_TASK_PREFIX)
}
