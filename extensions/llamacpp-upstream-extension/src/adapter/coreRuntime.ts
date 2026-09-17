/**
 * The upstream extension's binding of the shared core adapter (PLAN.md §4, stages 3b and 5).
 *
 * Everything that talks to the core lives in `extensions/shared/atomicCoreRuntime.ts`, shared with
 * the TurboQuant, MLX and Foundation Models extensions; this file binds it to `llamacpp-upstream`
 * and keeps the names this extension has always imported.
 */

import { invoke } from '@tauri-apps/api/core'

import type { SessionInfo, UnloadResult } from '@janhq/core'

import { createCoreRuntime } from '../../../shared/atomicCoreRuntime'
import type { CoreLoadOptions, Invoke } from '../../../shared/atomicCoreRuntime'

export {
  describeCoreError,
  isCoreError,
  modelIdsMatch,
} from '../../../shared/atomicCoreRuntime'
export type {
  CoreBackendPack,
  CoreError,
  CoreLoadOptions,
  CoreModelCapabilities,
  CoreOptimalState,
  CoreProxyConfig,
  CoreSessionSummary,
  CoreSettingsSnapshot,
  CoreSettingsStatus,
  CoreStatus,
} from '../../../shared/atomicCoreRuntime'

export const CORE_PROVIDER = 'llamacpp-upstream'

// Resolved per call, so a test that mocks `@tauri-apps/api/core` is the one the adapter uses.
const core = createCoreRuntime(CORE_PROVIDER, ((command, args) =>
      args === undefined ? invoke(command) : invoke(command, args)) as Invoke)

export const coreOwnsRuntime = core.coreOwnsRuntime
export const getStatus = core.getStatus
export const listSessions = core.listSessions
export const getLoadedModels = core.getLoadedModels
export const findSession = core.findSession
export const load = core.load as (modelId: string, options?: CoreLoadOptions) => Promise<SessionInfo>
export const unload = core.unload as (modelId: string) => Promise<UnloadResult>
export const increaseContext = core.increaseContext
export const recreateSession = core.recreateSession
export const importSettings = core.importSettings
export const getSettings = core.getSettings
export const acknowledgeSettings = core.acknowledgeSettings
export const settingsStatus = core.settingsStatus
export const sendHardwareOverride = core.sendHardwareOverride
export const listInstalledBackends = core.listInstalledBackends
export const installBackend = core.installBackend
export const cancelBackendDownload = core.cancelBackendDownload
export const removeBackend = core.removeBackend
export const getOptimalCache = core.getOptimalCache
export const setOptimalCache = core.setOptimalCache
export const getOptimalSnapshot = core.getOptimalSnapshot
export const capabilities = core.capabilities
export const validateGguf = core.validateGguf
export const devices = core.devices
export const embed = (input: string[], ubatchSize: number) => core.embed(input, ubatchSize)
