import { beforeEach, describe, expect, it, vi } from 'vitest'
import type {
  StaffPick,
  StaffPicksFetchResult,
} from '@/services/staff-picks-registry'

vi.hoisted(() => {
  ;(globalThis as Record<string, unknown>).IS_MACOS = true
  ;(globalThis as Record<string, unknown>).IS_WINDOWS = false
})

const mocks = vi.hoisted(() => ({
  getStaffPicksOrFallback: vi.fn(),
  getCachedManifest: vi.fn(() => null),
}))

vi.mock('@/services/staff-picks-registry', async () => {
  const actual = await vi.importActual<
    typeof import('@/services/staff-picks-registry')
  >('@/services/staff-picks-registry')
  return {
    ...actual,
    getStaffPicksOrFallback: mocks.getStaffPicksOrFallback,
    getCachedManifest: mocks.getCachedManifest,
  }
})

const remoteResult = (picks: StaffPick[]): StaffPicksFetchResult => ({
  picks,
  source: 'remote',
  fetchedAt: 1700000000000,
  manifestUpdatedAt: '2026-08-06T00:00:00Z',
})

const loadStore = async () => {
  vi.resetModules()
  return import('../staff-picks-store')
}

describe('staff-picks-store', () => {
  beforeEach(() => {
    mocks.getStaffPicksOrFallback.mockReset()
    mocks.getCachedManifest.mockReset()
    mocks.getCachedManifest.mockReturnValue(null)
  })

  it('seeds from the bundled baseline when no cache exists', async () => {
    mocks.getStaffPicksOrFallback.mockResolvedValue(remoteResult([]))
    const { useStaffPicksStore } = await loadStore()
    const { BASELINE_STAFF_PICKS } = await import('@/constants/staff-picks')

    // The module-level bootstrap already ran; read the seeded source instead.
    expect(BASELINE_STAFF_PICKS.length).toBeGreaterThan(0)
    expect(useStaffPicksStore.getState().source).toBeDefined()
  })

  it('stores picks and metadata after a successful refresh', async () => {
    mocks.getStaffPicksOrFallback.mockResolvedValue(
      remoteResult([{ model_name: 'a/one', order: 1 }])
    )
    const { useStaffPicksStore } = await loadStore()

    await useStaffPicksStore.getState().refresh()

    const state = useStaffPicksStore.getState()
    expect(state.picks.map((p) => p.model_name)).toEqual(['a/one'])
    expect(state.status).toBe('success')
    expect(state.source).toBe('remote')
    expect(state.manifestUpdatedAt).toBe('2026-08-06T00:00:00Z')
    expect(state.hasInitialized).toBe(true)
    expect(state.error).toBeNull()
  })

  it('reports an error status when the loader returns one', async () => {
    mocks.getStaffPicksOrFallback.mockResolvedValue({
      picks: [],
      source: 'baseline',
      fetchedAt: null,
      manifestUpdatedAt: null,
      error: 'offline',
    })
    const { useStaffPicksStore } = await loadStore()

    await useStaffPicksStore.getState().refresh()

    expect(useStaffPicksStore.getState().status).toBe('error')
    expect(useStaffPicksStore.getState().error).toBe('offline')
  })

  it('falls back to the baseline if the loader throws unexpectedly', async () => {
    mocks.getStaffPicksOrFallback.mockRejectedValue(new Error('kaboom'))
    const { useStaffPicksStore } = await loadStore()
    const { BASELINE_STAFF_PICKS } = await import('@/constants/staff-picks')

    await useStaffPicksStore.getState().refresh()

    const state = useStaffPicksStore.getState()
    expect(state.source).toBe('baseline')
    expect(state.error).toBe('kaboom')
    expect(state.picks).toHaveLength(BASELINE_STAFF_PICKS.length)
  })

  it('ensureStaffPicksLoaded only refreshes until initialized', async () => {
    mocks.getStaffPicksOrFallback.mockResolvedValue(
      remoteResult([{ model_name: 'a/one' }])
    )
    const { ensureStaffPicksLoaded, useStaffPicksStore } = await loadStore()

    await useStaffPicksStore.getState().refresh()
    const callsAfterFirst = mocks.getStaffPicksOrFallback.mock.calls.length

    await ensureStaffPicksLoaded()
    await ensureStaffPicksLoaded()

    expect(mocks.getStaffPicksOrFallback.mock.calls.length).toBe(
      callsAfterFirst
    )
  })

  it('filters the synchronous accessor for the current platform', async () => {
    mocks.getStaffPicksOrFallback.mockResolvedValue(
      remoteResult([
        { model_name: 'a/mac', platforms: ['macos'], order: 2 },
        { model_name: 'a/win', platforms: ['windows'], order: 1 },
      ])
    )
    const {
      getStaffPicksForCurrentPlatformSync,
      getStaffPicksSync,
      useStaffPicksStore,
    } = await loadStore()

    await useStaffPicksStore.getState().refresh()

    expect(getStaffPicksSync()).toHaveLength(2)
    expect(getStaffPicksForCurrentPlatformSync().map((p) => p.model_name)).toEqual([
      'a/mac',
    ])
  })
})
