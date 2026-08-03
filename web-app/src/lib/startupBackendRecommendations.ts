import { CACHE_EXPIRY_MS } from '@/constants/localStorage'
import type { BackendRuntimeEvent } from '@/hooks/useBackendMismatch'
import type { OptimalBackendCacheRecord } from '@/hooks/useBackendUpdater'

const CACHE_SCHEMA_VERSION = 1

type OptimalBackendExtension = {
  getCachedOptimalBackend?: () => OptimalBackendCacheRecord | null
  refreshOptimalBackendCache?: (options?: {
    hardwareHasNoGpu?: boolean
  }) => Promise<OptimalBackendCacheRecord | null>
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
