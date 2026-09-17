/**
 * An extension's half of the handover to `atomic-chat-core`, for any local provider
 * (PLAN.md §4, stages 3b and 5).
 *
 * When the core owns a provider's runtime, loading a model, unloading it and asking where it is
 * served all happen in another process. This module is everything an extension needs to talk to it
 * — and nothing else: the extension keeps its model catalogue and settings UI.
 *
 * It lives outside the extension packages and imports nothing: every extension has its own
 * `node_modules`, so the caller hands over its own `invoke` and each bundle carries one copy.
 *
 * Two rules it exists to enforce.
 *
 * *Never cache a session.* An extension's session cache was written when the extension owned the
 * process and knew exactly when it died. It no longer does: a core can reload a model with a larger
 * context, or be restarted by someone else entirely, and either way the port changes without the
 * extension being asked. So every lookup goes to the core.
 *
 * *Never reach for the control token.* The webview cannot see it; the `atomic_core_call` command in
 * Rust attaches it. That is also why this is a request builder rather than an HTTP client — there is
 * no URL here to get wrong.
 */

export type CoreProvider =
  | 'llamacpp-upstream'
  | 'llamacpp'
  | 'mlx'
  | 'foundation-models'

/** The `atomic_core.runtime` flag value that hands every local runtime to the core. */
export const ALL_RUNTIMES = 'all'

export type Invoke = <T>(
  command: string,
  args?: Record<string, unknown>
) => Promise<T>

/** The error shape the core returns, surfaced by the Rust command unchanged. */
export interface CoreError {
  code: string
  message: string
  details?: string
}

export interface CoreSessionInfo {
  pid: number
  port: number
  model_id: string
  model_path: string
  is_embedding: boolean
  api_key: string
  mmproj_path?: string | null
  runtime_device?: unknown
}

export interface CoreSessionSummary extends CoreSessionInfo {
  provider?: string
}

export interface CoreUnloadResult {
  success: boolean
  error?: string
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

export interface CoreLoadOptions {
  /** Per-model overrides, the same object the legacy `load()` takes. */
  settings?: Record<string, unknown>
  isEmbedding?: boolean
  bypassAutoUnload?: boolean
}

export type CoreCtxIncrease =
  | { ok: true; new_ctx_len: number }
  | {
      ok: false
      reason: string
      current_ctx_len?: number
      max_ctx_len?: number
    }

export interface CoreSettingsImport {
  status: 'imported' | 'unchanged' | 'merged' | 'conflict'
  applied: string[]
  conflicts: Array<{
    key: string
    base: unknown
    core: unknown
    legacy: unknown
  }>
  revision: number
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

export interface CoreOptimalState<T> {
  revision: number
  optimal: T | null
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

export interface CoreSettingsStatus {
  revision: number
  scopes: Record<
    string,
    {
      migrated: boolean
      acknowledged_revision: number | null
      in_sync: boolean
    }
  >
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

/**
 * The proxy's matching rule, repeated here so an extension resolves a model the same way every
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

/** Whether a runtime owner named by the app covers this provider. */
export function runtimeCovers(
  owner: string | null | undefined,
  provider: CoreProvider
): boolean {
  return owner === provider || owner === ALL_RUNTIMES
}

export function createCoreRuntime(provider: CoreProvider, invoke: Invoke) {
  const call = <T>(method: string, path: string, body?: unknown): Promise<T> =>
    invoke<T>('atomic_core_call', { method, path, body: body ?? null })

  /** A model id is the rest of the path: ids contain `/` and the core matches on everything after. */
  const modelPath = (modelId: string, suffix: string) =>
    `/models/${provider}/${modelId}/${suffix}`

  async function getStatus(): Promise<CoreStatus> {
    return invoke<CoreStatus>('atomic_core_status')
  }

  /** Hold the selected owner steady across preparation as well as the actual spawn. */
  async function withRuntimeLoad<T>(operation: () => Promise<T>): Promise<T> {
    let id: number
    try {
      id = await invoke<number>('atomic_core_begin_runtime_load', { provider })
    } catch (error) {
      // Mobile has no desktop core or its Tauri commands; keep its legacy engine path.
      if (
        /unknown command|command .*not found|command .*not registered/i.test(
          String(error)
        )
      )
        return operation()
      throw error
    }
    try {
      return await operation()
    } finally {
      await invoke('atomic_core_end_runtime_load', { id })
    }
  }

  /**
   * Whether this app has handed this provider's runtime to the core.
   *
   * Read per call rather than cached: the flag can be flipped from settings while the app runs, and
   * the whole point of it is that the next operation goes the other way.
   */
  async function coreOwnsRuntime(): Promise<boolean> {
    try {
      const status = await getStatus()
      // Nothing to read is a build or host without the core, the same as no such command.
      if (!status || typeof status !== 'object') return false
      if (status.transitioning) {
        throw Object.assign(
          new Error('The Atomic Chat runtime owner is changing.'),
          {
            code: 'CORE_TRANSITIONING',
          }
        )
      }
      // New builds distinguish the persisted request from the owner that has completed handover.
      // Falling back to flags keeps the adapter usable with the first 3a builds.
      return runtimeCovers(
        'active_runtime' in status
          ? status.active_runtime
          : status.flags?.runtime,
        provider
      )
    } catch (error) {
      // No such command means a build without the core; that is not an error, it is the old world.
      if (/unknown command|command .* not found/i.test(String(error)))
        return false
      throw error
    }
  }

  async function listSessions(): Promise<CoreSessionSummary[]> {
    const response = await call<{ sessions: CoreSessionSummary[] }>(
      'GET',
      '/sessions'
    )
    // A session without a provider predates providers on the wire and is llama.cpp upstream's.
    return (response?.sessions ?? []).filter(
      (session) => (session.provider ?? 'llamacpp-upstream') === provider
    )
  }

  async function getLoadedModels(): Promise<string[]> {
    return (await listSessions()).map((session) => session.model_id)
  }

  /**
   * Where a model is served right now, or `undefined` when it is not loaded. Asked fresh every
   * time: the cost is one loopback round trip; the alternative is a request sent to a port that
   * belonged to this model ten seconds ago.
   */
  async function findSession(
    modelId: string
  ): Promise<CoreSessionSummary | undefined> {
    return (await listSessions()).find((session) =>
      modelIdsMatch(session.model_id, modelId)
    )
  }

  async function load(
    modelId: string,
    options: CoreLoadOptions = {}
  ): Promise<CoreSessionInfo> {
    const response = await call<{ session: CoreSessionInfo; created: boolean }>(
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

  async function unload(modelId: string): Promise<CoreUnloadResult> {
    return call<CoreUnloadResult>('POST', modelPath(modelId, 'unload'))
  }

  /**
   * Reload a model one context step larger. The core answers with a reason when there is no step to
   * take — `fit`, `at_max`, `unsupported` — outcomes, not failures, so they are returned.
   */
  async function increaseContext(
    modelId: string,
    reason = 'auto_increase_ctx'
  ): Promise<CoreCtxIncrease> {
    return call('POST', modelPath(modelId, 'ctx/increase'), { reason })
  }

  /** Restart a model at the context it already has, because its engine is poisoned. */
  async function recreateSession(
    modelId: string
  ): Promise<{ ok: boolean; reason?: string }> {
    return call('POST', modelPath(modelId, 'recreate'))
  }

  /**
   * Hand the app's settings for this provider to the core — before the first core-owned load
   * (PLAN.md §3.4). A conflict is reported, never resolved here: only the user can say which wins.
   */
  async function importSettings(
    values: Record<string, unknown>,
    resolutions?: Record<string, 'core' | 'legacy' | { value: unknown }>
  ): Promise<CoreSettingsImport> {
    return call('POST', `/settings/${provider}/import`, {
      values,
      ...(resolutions ? { resolutions } : {}),
    })
  }

  async function getSettings(): Promise<CoreSettingsSnapshot> {
    return call<CoreSettingsSnapshot>('GET', `/settings/${provider}`)
  }

  async function acknowledgeSettings(revision: number): Promise<void> {
    await call('POST', `/settings/${provider}/acknowledge`, { revision })
  }

  async function settingsStatus(): Promise<CoreSettingsStatus> {
    return call('GET', '/settings/status')
  }

  /**
   * Give the core the hardware numbers only the app can measure — NVML driver versions, compute
   * capabilities, Vulkan device ids — which backend selection is decided from. Sent before the
   * first load.
   */
  async function sendHardwareOverride(override: {
    gpus: unknown[]
    cpu_extensions?: string[]
    os_type?: string
  }): Promise<void> {
    await call('PUT', '/hardware/override', {
      ...override,
      source: 'tauri-plugin-hardware',
    })
  }

  /** Backend packs the core has on disk. `current` marks which row is the one in use. */
  async function listInstalledBackends(
    current = ''
  ): Promise<CoreBackendPack[]> {
    const query = current ? `?current=${encodeURIComponent(current)}` : ''
    const response = await call<{ backends: CoreBackendPack[] }>(
      'GET',
      `/backends/${provider}${query}`
    )
    return response?.backends ?? []
  }

  /**
   * Download and unpack a backend under the caller's task id — the one the progress bar already
   * listens on. `assetName` is TurboQuant's: the file its release index names for this pair.
   */
  async function installBackend(
    version: string,
    backend: string,
    taskId: string,
    force = false,
    proxy: CoreProxyConfig | null = null,
    assetName?: string
  ): Promise<{
    version: string
    backend: string
    installed: boolean
    path: string
  }> {
    return call('POST', `/backends/${provider}/install`, {
      version,
      backend,
      task_id: taskId,
      force,
      proxy,
      ...(assetName ? { asset_name: assetName } : {}),
    })
  }

  async function cancelBackendDownload(taskId: string): Promise<boolean> {
    const response = await call<{ cancelled: boolean }>(
      'POST',
      `/downloads/${taskId}/cancel`
    )
    return response.cancelled
  }

  async function removeBackend(
    version: string,
    backend: string
  ): Promise<boolean> {
    const response = await call<{ removed: boolean }>(
      'DELETE',
      `/backends/${provider}/${version}/${backend}`
    )
    return response?.removed ?? false
  }

  async function getOptimalCache<T>(): Promise<CoreOptimalState<T>> {
    return call<CoreOptimalState<T>>('GET', `/backends/${provider}/optimal`)
  }

  /** Store a detection, or `null` to forget one that no longer describes this machine. */
  async function setOptimalCache<T>(
    record: T | null,
    expectedRevision: number
  ): Promise<CoreOptimalState<T>> {
    const response = await call<{
      status: 'updated'
      current: CoreOptimalState<T>
    }>('PUT', `/backends/${provider}/optimal`, {
      optimal: record,
      expected_revision: expectedRevision,
    })
    return response.current
  }

  async function getOptimalSnapshot<T>(): Promise<CoreOptimalState<T> | null> {
    const response = await invoke<{
      snapshot: { optimal_backends?: Record<string, CoreOptimalState<T>> }
    }>('atomic_core_snapshot')
    return response.snapshot.optimal_backends?.[provider] ?? null
  }

  /** What a model is and can do, answered from the data folder without loading it. */
  async function capabilities(modelId: string): Promise<CoreModelCapabilities> {
    return call('GET', modelPath(modelId, 'capabilities'))
  }

  /** Whether a file can be imported as a text-generation model; answers rather than throws. */
  async function validateGguf(
    path: string
  ): Promise<{
    isValid: boolean
    error?: string
    metadata?: Record<string, string>
  }> {
    return call('POST', '/gguf/validate', { path })
  }

  /** Devices the installed backend reports. Empty when no backend is installed yet. */
  async function devices<T>(): Promise<T[]> {
    const response = await call<{ devices: T[] }>(
      'GET',
      `/hardware/devices?provider=${provider}`
    )
    return response?.devices ?? []
  }

  async function embed(
    input: string[],
    ubatchSize: number,
    modelId = 'sentence-transformer-mini'
  ): Promise<unknown> {
    return call('POST', modelPath(modelId, 'embed'), {
      input,
      ubatch_size: ubatchSize,
    })
  }

  /** Whether Apple's on-device model can run here: the server's own `--check` token. */
  async function foundationModelsAvailability(force = false): Promise<string> {
    const response = await call<{ status: string }>(
      'GET',
      `/runtimes/foundation-models/availability${force ? '?force=1' : ''}`
    )
    return response.status
  }

  return {
    provider,
    getStatus,
    withRuntimeLoad,
    coreOwnsRuntime,
    listSessions,
    getLoadedModels,
    findSession,
    load,
    unload,
    increaseContext,
    recreateSession,
    importSettings,
    getSettings,
    acknowledgeSettings,
    settingsStatus,
    sendHardwareOverride,
    listInstalledBackends,
    installBackend,
    cancelBackendDownload,
    removeBackend,
    getOptimalCache,
    setOptimalCache,
    getOptimalSnapshot,
    capabilities,
    validateGguf,
    devices,
    embed,
    foundationModelsAvailability,
  }
}

export type CoreRuntime = ReturnType<typeof createCoreRuntime>
