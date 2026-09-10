import { renderHook } from '@testing-library/react'
import { afterEach, beforeEach, describe, expect, it, vi } from 'vitest'

const mocks = vi.hoisted(() => ({
  hardwareData: {
    cpu: { arch: 'arm64', core_count: 8, extensions: [], name: 'M1', usage: 0 },
    gpus: [] as Array<{ total_memory?: number }>,
    os_type: 'macos',
    os_name: 'macOS',
    total_memory: 64 * 1024, // a 64 GiB Mac — the top unified rung
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

    expect(result.current.tier).toBe('unified_32_plus')
    expect(result.current.ready).toBe(true)
    expect(result.current.profile).toMatchObject({
      memoryKind: 'unified',
      hardCeiling: true,
    })
  })

  it('pins the tier to the dev override, ignoring real hardware', async () => {
    const useHardwareTier = await loadHook('vram_2')
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current.tier).toBe('vram_2')
    expect(result.current.ready).toBe(true)
  })

  it('keeps accepting the two values the flag used to take', async () => {
    // `make dev-onboarding-low-spec` passes FORCE_HARDWARE_TIER=low, and so
    // does anyone's shell history. Aliased onto the nearest rung rather than
    // rejected, which would silently show the real machine's recommendation.
    const useHardwareTier = await loadHook('low')
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current.tier).toBe('vram_2')
  })

  it('reports the real machine even under an override', async () => {
    // The flag changes which model is offered; it must not fabricate hardware,
    // or the "why this one" line would quote memory the machine does not have.
    const useHardwareTier = await loadHook('vram_2')
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current.profile?.budgetMib).toBe(64 * 1024)
    expect(result.current.profile?.memoryKind).toBe('unified')
  })

  it('ignores a junk override rather than pinning to it', async () => {
    const useHardwareTier = await loadHook('potato')
    const { result } = renderHook(() => useHardwareTier())

    expect(result.current.tier).toBe('unified_32_plus')
  })

  it('falls back to a conservative tier while hardware is still unknown', async () => {
    mocks.hardwareData.total_memory = 0
    const useHardwareTier = await loadHook()
    const { result } = renderHook(() => useHardwareTier())

    // `ready: false` is what holds the picker behind its short deadline; the
    // tier is the one the picker uses if that deadline elapses first.
    expect(result.current).toEqual({
      tier: 'vram_8',
      profile: null,
      ready: false,
    })
  })
})
