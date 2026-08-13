import { CACHE_EXPIRY_MS, localStorageKey } from '@/constants/localStorage'
import type { BackendRuntimeEvent } from '@/hooks/useBackendMismatch'
import type { OptimalBackendCacheRecord } from '@/hooks/useBackendUpdater'

const CACHE_SCHEMA_VERSION = 1

type OptimalBackendExtension = {
  getCachedOptimalBackend?: () => OptimalBackendCacheRecord | null
  refreshOptimalBackendCache?: (options?: {
    hardwareHasNoGpu?: boolean
  }) => Promise<OptimalBackendCacheRecord | null>
  downloadRecommendedBackend?: (backendString: string) => Promise<void>
}

type ExtensionLookup = {
  getByName: (name: string) => unknown
}

const PROVIDERS = [
  {
    provider: 'llamacpp-upstream' as const,
    extensionName: '@janhq/llamacpp-upstream-extension',
  },
  {
    provider: 'llamacpp' as const,
    extensionName: '@janhq/llamacpp-extension',
  },
]

export function isOptimalBackendCacheFresh(
  record: OptimalBackendCacheRecord | null,
  now = Date.now()
): boolean {
  return (
    record?.schemaVersion === CACHE_SCHEMA_VERSION &&
    Number.isFinite(record.detectedAt) &&
    now - record.detectedAt >= 0 &&
    now - record.detectedAt < CACHE_EXPIRY_MS
  )
}

/**
 * Refresh providers sequentially: both detection paths can touch manifests and
 * spawn backend probes, so running them in parallel would compete for startup
 * I/O. A confirmed CPU-only host takes the extensions' no-probe fast path.
 */
export async function refreshStartupBackendCaches(
  extensions: ExtensionLookup,
  hardwareHasNoGpu: boolean,
  now = Date.now()
): Promise<
  Partial<Record<OptimalBackendCacheRecord['provider'], OptimalBackendCacheRecord>>
> {
  const records: Partial<
    Record<OptimalBackendCacheRecord['provider'], OptimalBackendCacheRecord>
  > = {}

  for (const config of PROVIDERS) {
    const extension = extensions.getByName(
      config.extensionName
    ) as OptimalBackendExtension | null
    if (!extension) continue

    const cached = extension.getCachedOptimalBackend?.() ?? null
    if (cached) records[config.provider] = cached
    if (isOptimalBackendCacheFresh(cached, now)) continue
    if (!extension.refreshOptimalBackendCache) continue

    try {
      const refreshed = await extension.refreshOptimalBackendCache({
        hardwareHasNoGpu,
      })
      if (refreshed) records[config.provider] = refreshed
    } catch (error) {
      // Startup optimization is best-effort. Keep the last successful record;
      // the manual Find/Upgrade paths still surface actionable failures.
      console.info(
        `[backend-recommendation] ${config.provider} background detection unavailable`,
        error
      )
    }
  }

  return records
}

type StartupUpgradeAttempt = {
  target: string
  attemptedAt: number
}

function readUpgradeAttempt(): StartupUpgradeAttempt | null {
  try {
    const raw = localStorage.getItem(localStorageKey.startupBackendUpgradeAttempt)
    if (!raw) return null
    const parsed = JSON.parse(raw) as Partial<StartupUpgradeAttempt>
    if (typeof parsed?.target !== 'string') return null
    if (!Number.isFinite(parsed.attemptedAt)) return null
    return { target: parsed.target, attemptedAt: parsed.attemptedAt as number }
  } catch {
    return null
  }
}

/**
 * Decides whether the silent startup upgrade may run for `record`, and to which
 * `<tag>/<backend-id>`.
 *
 * Only the upstream provider auto-applies: doing it for turboquant as well would
 * mean two uncontrolled multi-hundred-megabyte downloads in one launch, so its
 * "Find optimal backend" stays manual.
 *
 * Only a change of backend *id* counts. A newer tag for the same id is the tag
 * reconciler's job (`reconcileBackendReleaseTag()`); treating it as a tier
 * upgrade here would put two paths on the same archive.
 */
export function planStartupBackendUpgrade(
  record: OptimalBackendCacheRecord | null | undefined,
  now = Date.now(),
  attempt = readUpgradeAttempt()
): string | null {
  if (record?.provider !== 'llamacpp-upstream') return null
  if (record.detectionKind !== 'gpu') return null

  const target = record.recommendedBackend
  if (!target || target === record.currentBackend) return null

  const targetId = target.split('/')[1] ?? ''
  if (!targetId || targetId === (record.currentBackend.split('/')[1] ?? '')) {
    return null
  }

  /// ROCm unpacks to ~980 MB (`ggml-hip.dll` alone is 924 MB). That does not go
  /// to disk without the user seeing the number, so it stays on the explicit
  /// recommendation dialog.
  if (targetId.includes('rocm')) return null

  if (
    attempt?.target === target &&
    now - attempt.attemptedAt >= 0 &&
    now - attempt.attemptedAt < CACHE_EXPIRY_MS
  ) {
    return null
  }

  return target
}

/**
 * Downloads and hot-swaps the tier detection picked for this host, without any
 * confirmation UI. `downloadRecommendedBackend()` emits the same download
 * events as the manual path, so the progress banner in `BackendUpdater` covers
 * this too.
 *
 * The attempt is recorded before the download starts: a failure (or a crash
 * mid-download) must not retry on every single launch.
 */
export async function applyStartupBackendUpgrade(
  extensions: ExtensionLookup,
  records: Partial<
    Record<OptimalBackendCacheRecord['provider'], OptimalBackendCacheRecord>
  >,
  now = Date.now()
): Promise<string | null> {
  const target = planStartupBackendUpgrade(records['llamacpp-upstream'], now)
  if (!target) return null

  const extension = extensions.getByName(
    '@janhq/llamacpp-upstream-extension'
  ) as OptimalBackendExtension | null
  if (!extension?.downloadRecommendedBackend) return null

  try {
    localStorage.setItem(
      localStorageKey.startupBackendUpgradeAttempt,
      JSON.stringify({ target, attemptedAt: now } satisfies StartupUpgradeAttempt)
    )
    await extension.downloadRecommendedBackend(target)
    return target
  } catch (error) {
    console.info(
      `[backend-recommendation] llamacpp-upstream startup upgrade to ${target} failed`,
      error
    )
    return null
  }
}

export function buildLateBackendMismatch({
  record,
  provider,
  modelId,
  modelIsActive,
  currentVersionBackend,
}: {
  record: OptimalBackendCacheRecord | null
  provider: string
  modelId: string | null
  modelIsActive: boolean
  currentVersionBackend: string
}): BackendRuntimeEvent | null {
  if (
    (provider !== 'llamacpp' && provider !== 'llamacpp-upstream') ||
    record?.provider !== provider ||
    record.detectionKind !== 'gpu' ||
    !record.idealBackendId ||
    !modelId ||
    !modelIsActive
  ) {
    return null
  }

  const configured =
    currentVersionBackend.replace(/\uFEFF/g, '').trim().split('/')[1] ?? ''
  if (!configured.toLowerCase().includes('cpu')) return null

  return {
    provider,
    modelId,
    configuredVersionBackend: currentVersionBackend,
    effectiveVersionBackend: currentVersionBackend,
    mismatch: {
      kind: 'suboptimal-config',
      configured,
      ideal: record.idealBackendId,
    },
  }
}
