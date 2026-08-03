import { describe, expect, it, vi } from 'vitest'

import type { OptimalBackendCacheRecord } from '@/hooks/useBackendUpdater'
import {
  buildLateBackendMismatch,
  isOptimalBackendCacheFresh,
  refreshStartupBackendCaches,
} from '@/lib/startupBackendRecommendations'

const NOW = 1_800_000_000_000

function gpuRecord(
  provider: OptimalBackendCacheRecord['provider'],
  detectedAt = NOW
): OptimalBackendCacheRecord {
  return {
    schemaVersion: 1,
    provider,
    detectedAt,
    detectionKind: 'gpu',
    currentBackend: 'v1/cpu',
    idealBackendId: 'gpu',
    recommendedBackend: 'v1/gpu',
    recommendedCategory: 'GPU',
  }
}

describe('StartupBackendCoordinator helpers', () => {
  it('accepts a cache younger than 24 hours', () => {
    expect(isOptimalBackendCacheFresh(gpuRecord('llamacpp-upstream'), NOW)).toBe(
      true
    )
    expect(
      isOptimalBackendCacheFresh(
        gpuRecord('llamacpp-upstream', NOW - 24 * 60 * 60 * 1000),
        NOW
      )
    ).toBe(false)
  })

  it('uses fresh provider caches without running detection', async () => {
    const refresh = vi.fn()
    const extensions = {
      getByName: (name: string) => ({
        getCachedOptimalBackend: () =>
          gpuRecord(name.includes('upstream') ? 'llamacpp-upstream' : 'llamacpp'),
        refreshOptimalBackendCache: refresh,
      }),
    }

    const result = await refreshStartupBackendCaches(extensions, false, NOW)

    expect(refresh).not.toHaveBeenCalled()
    expect(Object.keys(result)).toEqual(['llamacpp-upstream', 'llamacpp'])
  })

  it('refreshes upstream before Turboquant and forwards the CPU-only fast path', async () => {
    const order: string[] = []
    const extensions = {
      getByName: (name: string) => {
        const provider = name.includes('upstream')
          ? ('llamacpp-upstream' as const)
          : ('llamacpp' as const)
        return {
          getCachedOptimalBackend: () => null,
          refreshOptimalBackendCache: vi.fn(
            async (options: { hardwareHasNoGpu?: boolean }) => {
              order.push(provider)
              expect(options.hardwareHasNoGpu).toBe(true)
              return {
                schemaVersion: 1 as const,
                provider,
                detectedAt: NOW,
                detectionKind: 'cpu-optimal' as const,
                currentBackend: 'v1/cpu',
              }
            }
          ),
        }
      },
    }

    const result = await refreshStartupBackendCaches(extensions, true, NOW)

    expect(order).toEqual(['llamacpp-upstream', 'llamacpp'])
    expect(result['llamacpp-upstream']?.detectionKind).toBe('cpu-optimal')
    expect(result.llamacpp?.detectionKind).toBe('cpu-optimal')
  })

  it('keeps a stale successful cache when refresh fails', async () => {
    const stale = gpuRecord('llamacpp-upstream', 1)
    const extensions = {
      getByName: (name: string) =>
        name.includes('upstream')
          ? {
              getCachedOptimalBackend: () => stale,
              refreshOptimalBackendCache: vi.fn().mockRejectedValue(new Error('offline')),
            }
          : null,
    }

    const result = await refreshStartupBackendCaches(extensions, false, NOW)

    expect(result['llamacpp-upstream']).toEqual(stale)
  })

  it('bridges a late GPU recommendation for an already active CPU model', () => {
    expect(
      buildLateBackendMismatch({
        record: gpuRecord('llamacpp-upstream'),
        provider: 'llamacpp-upstream',
        modelId: 'local-model',
        modelIsActive: true,
        currentVersionBackend: 'v1/win-cpu-x64',
      })
    ).toEqual({
      provider: 'llamacpp-upstream',
      modelId: 'local-model',
      configuredVersionBackend: 'v1/win-cpu-x64',
      effectiveVersionBackend: 'v1/win-cpu-x64',
      mismatch: {
        kind: 'suboptimal-config',
        configured: 'win-cpu-x64',
        ideal: 'gpu',
      },
    })
  })

  it('does not bridge recommendations into cloud or inactive sessions', () => {
    const record = gpuRecord('llamacpp-upstream')

    expect(
      buildLateBackendMismatch({
        record,
        provider: 'openai',
        modelId: 'cloud-model',
        modelIsActive: true,
        currentVersionBackend: 'v1/cpu',
      })
    ).toBeNull()
    expect(
      buildLateBackendMismatch({
        record,
        provider: 'llamacpp-upstream',
        modelId: 'local-model',
        modelIsActive: false,
        currentVersionBackend: 'v1/cpu',
      })
    ).toBeNull()
    expect(
      buildLateBackendMismatch({
        record,
        provider: 'llamacpp',
        modelId: 'turbo-model',
        modelIsActive: true,
        currentVersionBackend: 'v1/cpu',
      })
    ).toBeNull()
  })
})
