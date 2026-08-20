import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hardwareData: {
    cpu: { arch: 'arm64', core_count: 8, extensions: [], name: 'M1', usage: 0 },
    gpus: [] as Array<{ total_memory?: number }>,
    os_type: 'macos',
    os_name: 'macOS',
    total_memory: 64 * 1024, // comfortably standard
  },
}))

vi.mock('@/hooks/useHardware', () => ({
  useHardware: (selector: (s: unknown) => unknown) =>
    selector({ hardwareData: mocks.hardwareData }),
}))

/// The override is a compile-time constant read at module load, so each case
/// has to stub the global and re-import the module.
const loadHook = async (forced?: string) => {
  vi.resetModules()
  vi.stubGlobal('FORCE_HARDWARE_TIER', forced ?? '')
  vi.stubGlobal('IS_MACOS', true)
  return (await import('../useHardwareTier')).useHardwareTier
}

describe('useHardwareTier', () => {
  beforeEach(() => {
    mocks.hardwareData.total_memory = 64 * 1024
    mocks.hardwareData.gpus = []
  })

  afterEach(() => {
    vi.unstubAllGlobals()
  })

  it('reports the detected tier when the override is unset', async () => {
    const useHardwareTier = await loadHook()
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current).toEqual({ tier: 'standard', ready: true })
  })

  it('pins the tier to the dev override, ignoring real hardware', async () => {
    // 64 GB would detect as 'standard'; the whole point of the flag is to
    // review the low-spec picker on a machine that is not low-spec.
    const useHardwareTier = await loadHook('low')
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current).toEqual({ tier: 'low', ready: true })
  })

  it('ignores a junk override rather than pinning to it', async () => {
    const useHardwareTier = await loadHook('potato')
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current.tier).toBe('standard')
  })

  it('falls back to standard while hardware is still unknown', async () => {
    mocks.hardwareData.total_memory = 0
    const useHardwareTier = await loadHook()
    const { result } = renderHook(() => useHardwareTier())

    // `ready: false` is what holds the picker behind its short deadline.
    expect(result.current).toEqual({ tier: 'standard', ready: false })
  })
})
