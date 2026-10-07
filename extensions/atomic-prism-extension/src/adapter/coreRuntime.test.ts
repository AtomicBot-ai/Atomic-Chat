import { describe, it, expect, vi, beforeEach } from 'vitest'
import { invoke } from '@tauri-apps/api/core'
import * as coreRuntime from './coreRuntime'

beforeEach(() => {
  vi.clearAllMocks()
})

describe('the PrismML core adapter', () => {
  it('is bound to atomic-prism', async () => {
    expect(coreRuntime.CORE_PROVIDER).toBe('atomic-prism')
    vi.mocked(invoke).mockResolvedValue({ success: true })

    await coreRuntime.unload('bonsai')
    await coreRuntime.checkBackendUpdates({ current: 'prism-b1-abcdef0/macos-arm64' })

    expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/models/atomic-prism/bonsai/unload',
      body: null,
    })
    expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
      method: 'POST',
      path: '/backends/atomic-prism/updates',
      body: { current: 'prism-b1-abcdef0/macos-arm64' },
    })
  })

  it('asks the snapshot without arguments', async () => {
    vi.mocked(invoke).mockResolvedValue({
      snapshot: { optimal_backends: { 'atomic-prism': { revision: 3, optimal: null } } },
    })
    await expect(coreRuntime.getOptimalSnapshot()).resolves.toEqual({ revision: 3, optimal: null })
    expect(invoke).toHaveBeenCalledWith('atomic_core_snapshot')
  })

  it('tells a PrismML model by its atomic_runtime', () => {
    expect(coreRuntime.isPrismModel({ atomic_runtime: { provider: 'atomic-prism' } })).toBe(true)
    expect(coreRuntime.isPrismModel({ atomic_runtime: { provider: 'llamacpp' } })).toBe(false)
    expect(coreRuntime.isPrismModel({})).toBe(false)
  })

  it('has no embedding call', () => {
    expect((coreRuntime as Record<string, unknown>).embed).toBeUndefined()
  })
})
