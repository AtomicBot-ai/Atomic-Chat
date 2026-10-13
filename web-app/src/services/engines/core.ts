/**
 * The four `/engines/*` routes of the core, through the Rust relay
 * (`atomic_core_call`). The update call has no client deadline
 * (`control_call_timeout`): a llama.cpp, sd.cpp or MLX update downloads inside
 * the request, and progress and cancellation go through the core's
 * `download:*` events and `POST /downloads/:task_id/cancel` under the caller's
 * `task_id`.
 *
 * A failure rejects with the relay's plain `{code, message, details?}`.
 */

import { invoke } from '@tauri-apps/api/core'

import type {
  EngineActivateResult,
  EngineBuildDeleteResult,
  EngineId,
  EngineOperationStarted,
  EngineSwapUpdateRequest,
  EngineReinstallRequest,
  EngineUpdateRequest,
  EngineUpdateResult,
  EngineVersionsRequest,
  EngineVersionsResponse,
} from './types'

const call = <T>(
  method: 'POST' | 'DELETE',
  path: string,
  body: unknown = null
) => invoke<T>('atomic_core_call', { method, path, body })

const build = (engine: EngineId, version: string, variant: string) =>
  `/engines/${engine}/builds/${encodeURIComponent(version)}/${encodeURIComponent(variant)}`

/** Every engine of this host: installed builds, the active one, the newest and the offer. */
export function engineVersions(
  request: EngineVersionsRequest = {}
): Promise<EngineVersionsResponse> {
  return call('POST', '/engines/versions', request)
}

/**
 * Apply an update. llama.cpp, sd.cpp and MLX answer once applied; a managed
 * engine answers with the removal that begins its reinstall.
 */
export function updateEngine(
  engine: EngineId,
  request: EngineSwapUpdateRequest
): Promise<EngineUpdateResult>
export function updateEngine(
  engine: EngineId,
  request: EngineReinstallRequest
): Promise<EngineOperationStarted>
export function updateEngine(
  engine: EngineId,
  request: EngineUpdateRequest
): Promise<EngineUpdateResult | EngineOperationStarted> {
  return call('POST', `/engines/${engine}/update`, request)
}

/** llama.cpp only: make an installed build the one the next load runs; the provider's models unload. */
export function activateEngineBuild(
  engine: EngineId,
  version: string,
  variant: string
): Promise<EngineActivateResult> {
  return call('POST', `${build(engine, version, variant)}/activate`)
}

/**
 * Remove one build. A managed engine answers with its removal;
 * `retain_models` keeps its models (the core's default).
 */
export function deleteEngineBuild(
  engine: EngineId,
  version: string,
  variant: string,
  options: { retain_models?: boolean } = {}
): Promise<EngineBuildDeleteResult | EngineOperationStarted> {
  const query =
    options.retain_models === undefined
      ? ''
      : `?retain_models=${options.retain_models}`
  return call('DELETE', `${build(engine, version, variant)}${query}`)
}
