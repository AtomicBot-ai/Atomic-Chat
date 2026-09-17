/**
 * The extension's half of the handover to `atomic-chat-core` (PLAN.md §4, stage 3b).
 *
 * When the core owns the `llamacpp-upstream` runtime, loading a model, unloading it and asking
 * where it is served all happen in another process. This module is everything the extension needs
 * to talk to it — and nothing else: the extension keeps its own model catalogue and settings UI;
 * backend transfers and embeddings also cross this adapter when the core owns the runtime.
 *
 * Two rules it exists to enforce.
 *
 * *Never cache a session.* The extension's `sessionCache` was written when the extension itself
 * owned the process and knew exactly when it died. It no longer does: a core can reload a model
 * with a larger context, and it can be restarted by someone else entirely, and either way the port
 * changes without the extension being asked. So every lookup here goes to the core.
 *
 * *Never reach for the control token.* The webview cannot see it; the `atomic_core_call` command in
 * Rust attaches it. That is also why this module is a thin request builder rather than an HTTP
 * client — there is no URL here to get wrong.
 */

import { invoke } from '@tauri-apps/api/core'

import type { SessionInfo, UnloadResult } from '@janhq/core'

export const CORE_PROVIDER = 'llamacpp-upstream'

/** The error shape the core returns, surfaced by the Rust command unchanged. */
export interface CoreError {
  code: string
  message: string
  details?: string
}

export function isCoreError(value: unknown): value is CoreError {
  return (
    !!value &&
    typeof value === 'object' &&
    typeof (value as CoreError).code === 'string' &&
    typeof (value as CoreError).message === 'string'
  )
}

/** A readable one-liner for a core failure, keeping the code the app branches on. */
export function describeCoreError(error: unknown): string {
  if (!isCoreError(error)) return String(error)
  return error.details
    ? `${error.message} (${error.details}) [${error.code}]`
    : `${error.message} [${error.code}]`
}

async function call<T>(
  method: string,
  path: string,
  body?: unknown
): Promise<T> {
  return invoke<T>('atomic_core_call', { method, path, body: body ?? null })
}

/** Percent-encode a model id for a path segment; ids contain `/` and the core matches on the rest. */
function modelPath(modelId: string, suffix: string): string {
  return `/models/${CORE_PROVIDER}/${modelId}/${suffix}`
}

export interface CoreSessionSummary extends SessionInfo {
  provider?: string
}

export interface CoreStatus {
  flags?: { attach?: boolean; runtime?: string | null }
  active_runtime?: string | null
  transitioning?: boolean
  attached?: { instance_id?: string; generation?: number } | null
}

export interface CoreSettingsSnapshot {
  provider: string
  revision: number
  values: Record<string, unknown>
  migration?: { acknowledged_revision?: number | null } | null
}

/**
 * Whether this app has handed the runtime to the core.
 *
 * Read per call rather than cached: the flag can be flipped from settings while the app runs, and
 * the whole point of it is that the next operation goes the other way.
 */
export async function coreOwnsRuntime(): Promise<boolean> {
  try {
    const status = await getStatus()
    if (status.transitioning) {
      throw Object.assign(
        new Error('The Atomic Chat runtime owner is changing.'),
        { code: 'CORE_TRANSITIONING' }
      )
    }
    // New builds distinguish the persisted request from the owner that has completed handover.
    // Falling back to flags keeps the adapter usable with the first 3a builds.
    return (
      ('active_runtime' in status
        ? status.active_runtime
        : status.flags?.runtime) === CORE_PROVIDER
    )
  } catch (error) {
    // No such command means a build without the core; that is not an error, it is the old world.
    if (/unknown command|command .* not found/i.test(String(error)))
      return false
    throw error
  }
}

export async function getStatus(): Promise<CoreStatus> {
  return invoke<CoreStatus>('atomic_core_status')
}

export async function listSessions(): Promise<CoreSessionSummary[]> {
  const response = await call<{ sessions: CoreSessionSummary[] }>(
    'GET',
    '/sessions'
  )
  return (response?.sessions ?? []).filter(
    (session) => (session.provider ?? CORE_PROVIDER) === CORE_PROVIDER
  )
}

export async function getLoadedModels(): Promise<string[]> {
  return (await listSessions()).map((session) => session.model_id)
}

/**
 * Where a model is served right now, or `undefined` when it is not loaded.
 *
 * Asked fresh every time. The cost is one loopback round trip; the cost of the alternative is a
 * request sent to a port that belonged to this model ten seconds ago.
 */
export async function findSession(
  modelId: string
): Promise<CoreSessionSummary | undefined> {
  const sessions = await listSessions()
  return sessions.find((session) => modelIdsMatch(session.model_id, modelId))
}

/**
 * The proxy's matching rule, repeated here so the extension resolves a model the same way every
 * other reader does: some clients and some filesystems swap `.` for `_`.
 */
export function modelIdsMatch(a: string, b: string): boolean {
  if (a.length !== b.length) return false
  for (let i = 0; i < a.length; i++) {
    const x = a[i]
    const y = b[i]
    if (x === y) continue
    if ((x === '.' && y === '_') || (x === '_' && y === '.')) continue
    return false
  }
  return true
}

export interface CoreLoadOptions {
  /** Per-model overrides, the same object the legacy `load()` takes. */
  settings?: Record<string, unknown>
  isEmbedding?: boolean
  bypassAutoUnload?: boolean
}

export async function load(
  modelId: string,
  options: CoreLoadOptions = {}
): Promise<SessionInfo> {
  const response = await call<{ session: SessionInfo; created: boolean }>(
    'POST',
    modelPath(modelId, 'load'),
    {
      ...(options.settings ? { overrides: options.settings } : {}),
      ...(options.isEmbedding !== undefined
        ? { isEmbedding: options.isEmbedding }
        : {}),
      ...(options.bypassAutoUnload !== undefined
        ? { bypassAutoUnload: options.bypassAutoUnload }
        : {}),
    }
  )
  return response.session
}

export async function unload(modelId: string): Promise<UnloadResult> {
  return call<UnloadResult>('POST', modelPath(modelId, 'unload'))
}

/**
 * Reload a model one context step larger.
 *
 * The core decides whether there is a step to take and answers with a reason when there is not —
 * `fit` (the engine sizes the window itself) or `at_max` (the model's trained context). Those are
 * outcomes, not failures, which is why this returns them rather than throwing.
 */
export async function increaseContext(
  modelId: string,
  reason = 'auto_increase_ctx'
): Promise<
  | { ok: true; new_ctx_len: number }
  | {
      ok: false
      reason: string
      current_ctx_len?: number
      max_ctx_len?: number
    }
> {
  return call('POST', modelPath(modelId, 'ctx/increase'), { reason })
}

/**
 * Restart a model at the context it already has, because its engine is poisoned (a compute failure
 * such as a Metal out-of-memory). The core owns the process, so it does the restart; growing the
 * context here would only make an out-of-memory failure more likely.
 */
export async function recreateSession(modelId: string): Promise<{ ok: boolean; reason?: string }> {
  return call('POST', modelPath(modelId, 'recreate'))
}

/**
 * Hand the app's settings for this provider to the core.
 *
 * Runs before the first core-owned load (PLAN.md §3.4): until a provider's settings are imported,
 * the app's copy is the truth and the core must not own its runtime. A conflict is reported, never
 * resolved here — both sides changed a value and only the user can say which one wins.
 */
export async function importSettings(
  values: Record<string, unknown>,
  resolutions?: Record<string, 'core' | 'legacy' | { value: unknown }>
): Promise<{
  status: 'imported' | 'unchanged' | 'merged' | 'conflict'
  applied: string[]
  conflicts: Array<{
    key: string
    base: unknown
    core: unknown
    legacy: unknown
  }>
  revision: number
}> {
  return call('POST', `/settings/${CORE_PROVIDER}/import`, {
    values,
    ...(resolutions ? { resolutions } : {}),
  })
}

export async function getSettings(): Promise<CoreSettingsSnapshot> {
  return call<CoreSettingsSnapshot>('GET', `/settings/${CORE_PROVIDER}`)
}

export async function acknowledgeSettings(revision: number): Promise<void> {
  await call('POST', `/settings/${CORE_PROVIDER}/acknowledge`, { revision })
}

/**
 * Give the core the hardware numbers only the app can measure.
 *
 * The core probes with shell tools; NVML driver versions, compute capabilities and Vulkan device
 * ids need native libraries it does not link, and those are exactly what the CUDA tier and the
 * Windows ROCm gfx target are chosen from. Sent before the first load for that reason.
 */
export async function sendHardwareOverride(override: {
  gpus: unknown[]
  cpu_extensions?: string[]
  os_type?: string
}): Promise<void> {
  await call('PUT', '/hardware/override', {
    ...override,
    source: 'tauri-plugin-hardware',
  })
}

export interface CoreBackendPack {
  version: string
  backend: string
  path: string
  active: boolean
}

export interface CoreProxyConfig {
  url: string
  username?: string
  password?: string
  no_proxy?: string[]
  ignore_ssl?: boolean
  verify_proxy_ssl?: boolean
  verify_proxy_host_ssl?: boolean
  verify_peer_ssl?: boolean
  verify_host_ssl?: boolean
}

/** Backend packs the core has on disk. `current` marks which row is the one in use. */
export async function listInstalledBackends(
  current = ''
): Promise<CoreBackendPack[]> {
  const query = current ? `?current=${encodeURIComponent(current)}` : ''
  const response = await call<{ backends: CoreBackendPack[] }>(
    'GET',
    `/backends/${CORE_PROVIDER}${query}`
  )
  return response?.backends ?? []
}

/**
 * Download and unpack a backend.
 *
 * `taskId` is the caller's, and it is what the progress events are named after — the same id the
 * extension already generates for its own downloads, so the bar the user is watching keeps working
 * without knowing which side did the fetching.
 */
export async function installBackend(
  version: string,
  backend: string,
  taskId: string,
  force = false,
  proxy: CoreProxyConfig | null = null
): Promise<{ version: string; backend: string; installed: boolean; path: string }> {
  return call('POST', `/backends/${CORE_PROVIDER}/install`, {
    version,
    backend,
    task_id: taskId,
    force,
    proxy,
  })
}

export async function cancelBackendDownload(taskId: string): Promise<boolean> {
  const response = await call<{ cancelled: boolean }>('POST', `/downloads/${taskId}/cancel`)
  return response.cancelled
}

export async function removeBackend(
  version: string,
  backend: string
): Promise<boolean> {
  const response = await call<{ removed: boolean }>(
    'DELETE',
    `/backends/${CORE_PROVIDER}/${version}/${backend}`
  )
  return response?.removed ?? false
}

/**
 * The optimal-backend detection the core has stored, if any.
 *
 * Kept by the core rather than in `localStorage` so the CLI sees the same answer, and so a data
 * a restarted app or CLI sees the same answer. Hardware-change invalidation is deliberately
 * separate: the current cache format does not contain a reliable machine fingerprint.
 */
export interface CoreOptimalState<T> {
  revision: number
  optimal: T | null
}

export async function getOptimalCache<T>(): Promise<CoreOptimalState<T>> {
  return call<CoreOptimalState<T>>(
    'GET',
    `/backends/${CORE_PROVIDER}/optimal`
  )
}

/** Store a detection, or `null` to forget one that no longer describes this machine. */
export async function setOptimalCache<T>(record: T | null, expectedRevision: number): Promise<CoreOptimalState<T>> {
  const response = await call<{ status: 'updated'; current: CoreOptimalState<T> }>(
    'PUT',
    `/backends/${CORE_PROVIDER}/optimal`,
    { optimal: record, expected_revision: expectedRevision }
  )
  return response.current
}

export async function getOptimalSnapshot<T>(): Promise<CoreOptimalState<T> | null> {
  const response = await invoke<{ snapshot: { optimal_backends?: Record<string, CoreOptimalState<T>> } }>('atomic_core_snapshot')
  return response.snapshot.optimal_backends?.[CORE_PROVIDER] ?? null
}

export interface CoreModelCapabilities {
  modelId: string
  maxCtxTrain?: number
  mmprojExists: boolean
  isEmbedding: boolean
  vision: boolean
  audio: boolean
  gemmaMtp: boolean
  dflash: boolean
  dflashDrafts: string[]
}

/** What a model is and can do, answered from the data folder without loading it. */
export async function capabilities(modelId: string): Promise<CoreModelCapabilities> {
  return call('GET', `/models/${CORE_PROVIDER}/${modelId}/capabilities`)
}

/**
 * Whether a file can be imported as a text-generation model.
 *
 * Answers rather than throws for a file that is not one — the user pointed at it, and saying so is
 * the answer to their question.
 */
export async function validateGguf(
  path: string
): Promise<{ isValid: boolean; error?: string; metadata?: Record<string, string> }> {
  return call('POST', '/gguf/validate', { path })
}

/** Devices the installed backend reports. Empty when no backend is installed yet. */
export async function devices<T>(): Promise<T[]> {
  const response = await call<{ devices: T[] }>(
    'GET',
    `/hardware/devices?provider=${CORE_PROVIDER}`
  )
  return response?.devices ?? []
}

export interface CoreSettingsStatus {
  revision: number
  scopes: Record<
    string,
    { migrated: boolean; acknowledged_revision: number | null; in_sync: boolean }
  >
}

/**
 * Whether this provider's settings have been handed over.
 *
 * The runtime flag must not be turned on for a scope that is not migrated: the core would load with
 * its own defaults rather than the user's.
 */
export async function settingsStatus(): Promise<CoreSettingsStatus> {
  return call('GET', '/settings/status')
}

export async function embed(input: string[], ubatchSize: number): Promise<unknown> {
  return call('POST', modelPath('sentence-transformer-mini', 'embed'), {
    input,
    ubatch_size: ubatchSize,
  })
}
