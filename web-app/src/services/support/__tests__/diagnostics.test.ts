import { beforeEach, describe, expect, it, vi } from 'vitest'

// The real store loads the provider registry over the network.
const selection = vi.hoisted(() => ({
  selectedProvider: '',
  selectedModel: null as { id: string } | null,
}))
vi.mock('@/hooks/useModelProvider', () => ({
  useModelProvider: { getState: () => selection },
}))

import { useServiceStore } from '@/hooks/useServiceHub'
import { useProductAnalytic } from '@/hooks/useAnalytic'
import type { ServiceHub } from '@/services'
import {
  collectSupportMeta,
  hashSupportMeta,
  resetSupportDiagnosticsCache,
} from '../diagnostics'

const hardware = {
  cpu: { arch: 'aarch64', name: 'Apple M3 Pro', core_count: 12 },
  gpus: [
    {
      vendor: 'Apple',
      name: 'Apple M3 Pro',
      total_memory: 18432,
      uuid: 'secret-uuid',
    },
  ],
  os_type: 'macos',
  os_name: 'macOS 26.0',
  total_memory: 36864,
}

const hub = (overrides: Partial<Record<string, unknown>> = {}) => {
  const services = {
    getCoreVersion: vi.fn(async () => '0.18.9'),
    getInstallerType: vi.fn(async () => 'dmg'),
    getHardwareInfo: vi.fn(async () => hardware),
    getAppDistinctId: vi.fn(async () => 'install-id'),
    ...overrides,
  }
  useServiceStore.setState({
    serviceHub: {
      app: () => ({
        getCoreVersion: services.getCoreVersion,
        getInstallerType: services.getInstallerType,
      }),
      hardware: () => ({ getHardwareInfo: services.getHardwareInfo }),
      analytic: () => ({ getAppDistinctId: services.getAppDistinctId }),
    } as unknown as ServiceHub,
  })
  return services
}

describe('support diagnostics', () => {
  beforeEach(() => {
    resetSupportDiagnosticsCache()
    localStorage.clear()
    useProductAnalytic.setState({ productAnalytic: true })
    selection.selectedProvider = 'llamacpp-upstream'
    selection.selectedModel = { id: 'Qwen3-4B-Q4_K_M' }
  })

  it('describes the app, the machine and the selected model', async () => {
    localStorage.setItem(
      'atomic_llamacpp_upstream_backend_type',
      'b6000/macos-arm64'
    )
    hub()

    const meta = await collectSupportMeta()

    expect(meta).toMatchObject({
      app_version: 'test',
      core_version: '0.18.9',
      installer_type: 'dmg',
      os_name: 'macOS 26.0',
      arch: 'aarch64',
      cpu: 'Apple M3 Pro',
      ram_gb: 36,
      gpus: [{ vendor: 'Apple', name: 'Apple M3 Pro', vram_gb: 18 }],
      backend: 'b6000/macos-arm64',
      provider: 'llamacpp-upstream',
      model: 'Qwen3-4B-Q4_K_M',
      posthog_distinct_id: 'install-id',
    })
    expect(meta.locale).toBeTruthy()
    expect(meta.timezone).toBeTruthy()
    expect(JSON.stringify(meta)).not.toContain('secret-uuid')
  })

  it('leaves the analytics id out while analytics is off', async () => {
    useProductAnalytic.setState({ productAnalytic: false })
    const services = hub()

    const meta = await collectSupportMeta()

    expect(meta.posthog_distinct_id).toBeUndefined()
    expect(services.getAppDistinctId).not.toHaveBeenCalled()
  })

  it('never throws, and reads the machine again after a failure', async () => {
    const failing = hub({
      getCoreVersion: vi.fn(async () => {
        throw new Error('core down')
      }),
      getInstallerType: vi.fn(() => {
        throw new Error('no shell')
      }),
      getHardwareInfo: vi.fn(async () => {
        throw new Error('no hardware')
      }),
    })

    const meta = await collectSupportMeta()

    expect(meta).toMatchObject({
      app_version: 'test',
      model: 'Qwen3-4B-Q4_K_M',
    })
    expect(meta.cpu).toBeUndefined()

    await collectSupportMeta()
    expect(failing.getHardwareInfo).toHaveBeenCalledTimes(2)
  })

  it('reads the machine once per session when it answered', async () => {
    const services = hub()
    await collectSupportMeta()
    await collectSupportMeta()
    expect(services.getHardwareInfo).toHaveBeenCalledTimes(1)
  })

  it('still collects what it can before services exist', async () => {
    useServiceStore.setState({ serviceHub: null })
    await expect(collectSupportMeta()).resolves.toMatchObject({
      app_version: 'test',
      provider: 'llamacpp-upstream',
    })
  })

  it('fingerprints the same diagnostics the same way, whatever the key order', () => {
    expect(hashSupportMeta({ app_version: '1', locale: 'en' })).toBe(
      hashSupportMeta({ locale: 'en', app_version: '1' })
    )
    expect(hashSupportMeta({ app_version: '1' })).not.toBe(
      hashSupportMeta({ app_version: '2' })
    )
  })
})
