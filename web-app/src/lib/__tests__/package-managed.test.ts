import { beforeEach, describe, expect, it, vi } from 'vitest'
import { clearMocks, mockIPC } from '@tauri-apps/api/mocks'

/// The helper remembers its answer for the life of the module, so each case
/// starts from a fresh copy.
async function loadHelper() {
  vi.resetModules()
  const { isPackageManaged } = await import('../package-managed')
  return isPackageManaged
}

describe('isPackageManaged', () => {
  beforeEach(() => {
    clearMocks()
  })

  it('asks the desktop once and remembers the answer', async () => {
    const ipc = vi.fn(() => true)
    mockIPC(ipc)
    const isPackageManaged = await loadHelper()

    await expect(isPackageManaged()).resolves.toBe(true)
    await expect(isPackageManaged()).resolves.toBe(true)

    expect(ipc).toHaveBeenCalledTimes(1)
    expect(ipc).toHaveBeenCalledWith('is_package_managed_install', {})
  })

  it('reads a rejection as "not package-managed" without remembering it', async () => {
    const ipc = vi.fn(() => {
      throw new Error('ipc not ready')
    })
    mockIPC(ipc)
    const isPackageManaged = await loadHelper()

    await expect(isPackageManaged()).resolves.toBe(false)

    // The desktop answers on the next call: that answer wins.
    clearMocks()
    mockIPC(() => true)
    await expect(isPackageManaged()).resolves.toBe(true)
    await expect(isPackageManaged()).resolves.toBe(true)
  })

  it('is false outside Tauri', async () => {
    const isPackageManaged = await loadHelper()

    await expect(isPackageManaged()).resolves.toBe(false)
  })
})
