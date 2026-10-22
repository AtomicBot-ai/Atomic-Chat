import { beforeEach, describe, expect, it, vi } from 'vitest'
import { mockIPC } from '@tauri-apps/api/mocks'

const mockPluginCheck = vi.hoisted(() => vi.fn())
vi.mock('@tauri-apps/plugin-updater', () => ({
  check: mockPluginCheck,
}))

vi.mock('@tauri-apps/plugin-store', () => ({
  load: vi.fn().mockResolvedValue({
    get: vi.fn().mockResolvedValue('seed'),
    set: vi.fn(),
    save: vi.fn(),
  }),
}))

/// `lib/package-managed` remembers its answer for the life of the module, so
/// each case loads a fresh copy of the service and its helper.
async function loadService(packageManaged: boolean, ipc: ReturnType<typeof vi.fn>) {
  vi.resetModules()
  mockIPC((command, args) => {
    if (command === 'is_package_managed_install') return packageManaged
    return ipc(command, args)
  })
  const { TauriUpdaterService } = await import('../tauri')
  return new TauriUpdaterService()
}

describe('TauriUpdaterService on a package-managed install', () => {
  let ipc: ReturnType<typeof vi.fn>

  beforeEach(() => {
    vi.clearAllMocks()
    ipc = vi.fn()
    mockPluginCheck.mockResolvedValue({
      version: '9.9.9',
      downloadAndInstall: vi.fn(),
    })
  })

  it('answers "no update" without the custom check or the plugin fallback', async () => {
    const service = await loadService(true, ipc)

    await expect(service.check()).resolves.toBeNull()

    expect(ipc).not.toHaveBeenCalledWith('check_for_app_updates', expect.anything())
    expect(mockPluginCheck).not.toHaveBeenCalled()
  })

  it('refuses to install', async () => {
    const service = await loadService(true, ipc)

    await service.installAndRestart()
    await expect(
      service.downloadAndInstallWithProgress(vi.fn())
    ).rejects.toThrow('package manager')

    expect(mockPluginCheck).not.toHaveBeenCalled()
  })

  it('still falls back to the plugin check on an ordinary install', async () => {
    ipc.mockImplementation((command: string) =>
      command === 'check_for_app_updates' ? null : undefined
    )
    const service = await loadService(false, ipc)

    await expect(service.check()).resolves.toMatchObject({ version: '9.9.9' })

    expect(ipc).toHaveBeenCalledWith(
      'check_for_app_updates',
      expect.objectContaining({ nonceSeed: 'seed' })
    )
    expect(mockPluginCheck).toHaveBeenCalledTimes(1)
  })
})
