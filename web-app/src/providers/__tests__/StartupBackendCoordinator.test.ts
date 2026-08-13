import { beforeEach, describe, expect, it, vi } from 'vitest'

import { localStorageKey } from '@/constants/localStorage'
import type { OptimalBackendCacheRecord } from '@/hooks/useBackendUpdater'
import {
  applyStartupBackendUpgrade,
  buildLateBackendMismatch,
  isOptimalBackendCacheFresh,
  planStartupBackendUpgrade,
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

describe('startup tier upgrade', () => {
  beforeEach(() => {
    localStorage.clear()
  })

  function upstreamRecords(
    overrides: Partial<Extract<OptimalBackendCacheRecord, { detectionKind: 'gpu' }>> = {}
  ) {
    return {
      'llamacpp-upstream': {
        ...gpuRecord('llamacpp-upstream'),
        currentBackend: 'b10405/win-vulkan-x64',
        idealBackendId: 'win-cuda-13-x64',
        recommendedBackend: 'b10405/win-cuda-13.3-x64',
        ...overrides,
      } as OptimalBackendCacheRecord,
    }
  }

  it('picks the detected tier for upstream', () => {
    expect(planStartupBackendUpgrade(upstreamRecords()['llamacpp-upstream'], NOW)).toBe(
      'b10405/win-cuda-13.3-x64'
    )
  })

  it('leaves turboquant to its manual button', async () => {
    const download = vi.fn()
    const applied = await applyStartupBackendUpgrade(
      {
        getByName: () => ({ downloadRecommendedBackend: download }),
      },
      { llamacpp: gpuRecord('llamacpp') },
      NOW
    )

    expect(applied).toBeNull()
    expect(download).not.toHaveBeenCalled()
  })

  it('ignores CPU-optimal detection and same-tier recommendations', () => {
    expect(
      planStartupBackendUpgrade(
        {
          schemaVersion: 1,
          provider: 'llamacpp-upstream',
          detectedAt: NOW,
          detectionKind: 'cpu-optimal',
          currentBackend: 'b10405/win-cpu-x64',
          recommendedCategory: 'CPU',
        },
        NOW
      )
    ).toBeNull()

    /// A newer tag for the same backend id belongs to the tag reconciler.
    expect(
      planStartupBackendUpgrade(
        upstreamRecords({
          currentBackend: 'b10344/win-cuda-13.3-x64',
          recommendedBackend: 'b10405/win-cuda-13.3-x64',
        })['llamacpp-upstream'],
        NOW
      )
    ).toBeNull()
  })

  it('never downloads ROCm unattended', () => {
    expect(
      planStartupBackendUpgrade(
        upstreamRecords({
          idealBackendId: 'win-rocm-x64',
          recommendedBackend: 'b10405/win-rocm-7.14-x64',
        })['llamacpp-upstream'],
        NOW
      )
    ).toBeNull()
  })

  it('records the attempt before downloading and does not retry it for a day', async () => {
    const download = vi.fn().mockRejectedValue(new Error('offline'))
    const extensions = { getByName: () => ({ downloadRecommendedBackend: download }) }

    expect(
      await applyStartupBackendUpgrade(extensions, upstreamRecords(), NOW)
    ).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)
    expect(
      JSON.parse(
        localStorage.getItem(localStorageKey.startupBackendUpgradeAttempt) ?? '{}'
      )
    ).toEqual({ target: 'b10405/win-cuda-13.3-x64', attemptedAt: NOW })

    expect(
      await applyStartupBackendUpgrade(
        extensions,
        upstreamRecords(),
        NOW + 23 * 60 * 60 * 1000
      )
    ).toBeNull()
    expect(download).toHaveBeenCalledTimes(1)

    expect(
      await applyStartupBackendUpgrade(
        extensions,
        upstreamRecords(),
        NOW + 25 * 60 * 60 * 1000
      )
    ).toBeNull()
    expect(download).toHaveBeenCalledTimes(2)
  })

  it('retries immediately when detection picks a different tier', async () => {
    const download = vi.fn().mockResolvedValue(undefined)
    const extensions = { getByName: () => ({ downloadRecommendedBackend: download }) }

    expect(
      await applyStartupBackendUpgrade(extensions, upstreamRecords(), NOW)
    ).toBe('b10405/win-cuda-13.3-x64')
    expect(
      await applyStartupBackendUpgrade(
        extensions,
        upstreamRecords({ recommendedBackend: 'b10405/win-cuda-12.4-x64' }),
        NOW
      )
    ).toBe('b10405/win-cuda-12.4-x64')
    expect(download).toHaveBeenCalledTimes(2)
  })
})
