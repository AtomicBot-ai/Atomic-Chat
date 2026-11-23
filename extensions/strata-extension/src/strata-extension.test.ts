import { beforeEach, describe, expect, it, vi } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import StrataExtension from './index'

vi.mock('@janhq/core', () => ({
  AIEngine: class {
    onLoad() {}
    async getSettings() {
      return []
    }
    async updateSettings() {}
  },
  fs: {},
}))
vi.mock('@tauri-apps/api/core', () => ({ invoke: vi.fn() }))
vi.mock('@tauri-apps/api/event', () => ({ listen: vi.fn() }))

const relay = vi.mocked(invoke)
beforeEach(() => relay.mockReset())

describe('Strata extension', () => {
  it('coalesces host discovery and trusts the active build reported by core', async () => {
    relay.mockResolvedValue({
      active: { tag: 'strata-0.1.59-r5' },
      host_backend_id: null,
    })
    const engine = new StrataExtension()
    expect(
      await Promise.all([
        engine.refreshVisibility(),
        engine.refreshVisibility(),
      ])
    ).toEqual([true, true])
    expect(relay).toHaveBeenCalledExactlyOnceWith('atomic_core_call', {
      method: 'POST',
      path: '/engine-builds/strata/catalog',
      body: {},
    })
    expect(engine.isHidden()).toBe(false)
  })

  it('distinguishes an old core from a supported core with no host bundle', async () => {
    relay.mockRejectedValueOnce({
      code: 'INVALID_ARGUMENT',
      message: 'Unknown engine build strata.',
    })
    const engine = new StrataExtension()
    expect(await engine.refreshVisibility()).toBe(false)
    expect(engine.visibilityReason()).toMatch(/Update Atomic Chat/)
    relay.mockResolvedValueOnce({
      active: null,
      host_backend_id: null,
      host_reason: 'No compatible GPU.',
    })
    expect(await engine.refreshVisibility()).toBe(false)
    expect(engine.visibilityReason()).toBe('No compatible GPU.')
  })
})
