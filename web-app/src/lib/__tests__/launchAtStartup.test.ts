import { beforeEach, describe, expect, it, vi } from 'vitest'
import {
  carryLaunchAtStartupAcrossRename,
  reconcileLaunchAtStartup,
  setLaunchAtStartup,
} from '../launchAtStartup'
import type { AppService } from '@/services/app/types'

const autostart = vi.hoisted(() => ({
  disable: vi.fn(),
  enable: vi.fn(),
  isEnabled: vi.fn(),
}))

vi.mock('@tauri-apps/plugin-autostart', () => autostart)

const createPreferenceStore = (
  preference: Awaited<ReturnType<AppService['getAutostartPreference']>>
) => ({
  getAutostartPreference: vi.fn().mockResolvedValue(preference),
  setAutostartPreference: vi.fn().mockResolvedValue(undefined),
})

describe('launch at startup', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('enables autostart for a clean installation exactly once', async () => {
    const store = createPreferenceStore('pending_default_on')
    autostart.isEnabled.mockResolvedValueOnce(false).mockResolvedValueOnce(true)

    await expect(reconcileLaunchAtStartup(store)).resolves.toBe(true)

    expect(autostart.enable).toHaveBeenCalledOnce()
    expect(store.setAutostartPreference).toHaveBeenCalledWith('enabled')
  })

  it('adopts existing OS state without changing it for upgraded users', async () => {
    const store = createPreferenceStore('unmanaged')
    autostart.isEnabled.mockResolvedValue(false)

    await expect(reconcileLaunchAtStartup(store)).resolves.toBe(false)

    expect(autostart.enable).not.toHaveBeenCalled()
    expect(autostart.disable).not.toHaveBeenCalled()
    expect(store.setAutostartPreference).toHaveBeenCalledWith('disabled')
  })

  it('preserves an autostart disable made through the operating system', async () => {
    const store = createPreferenceStore('enabled')
    autostart.isEnabled.mockResolvedValue(false)

    await expect(reconcileLaunchAtStartup(store)).resolves.toBe(false)

    expect(autostart.enable).not.toHaveBeenCalled()
    expect(store.setAutostartPreference).toHaveBeenCalledWith('disabled')
  })

  it('adopts an autostart enable made through the operating system', async () => {
    const store = createPreferenceStore('disabled')
    autostart.isEnabled.mockResolvedValue(true)

    await expect(reconcileLaunchAtStartup(store)).resolves.toBe(true)

    expect(autostart.disable).not.toHaveBeenCalled()
    expect(store.setAutostartPreference).toHaveBeenCalledWith('enabled')
  })

  it('persists the state applied by the Settings toggle', async () => {
    const store = createPreferenceStore('disabled')
    autostart.isEnabled.mockResolvedValue(true)

    await expect(setLaunchAtStartup(store, true)).resolves.toBe(true)

    expect(autostart.enable).toHaveBeenCalledOnce()
    expect(store.setAutostartPreference).toHaveBeenCalledWith('enabled')
  })

  it('disables autostart through the Settings toggle', async () => {
    const store = createPreferenceStore('enabled')
    autostart.isEnabled.mockResolvedValue(false)

    await expect(setLaunchAtStartup(store, false)).resolves.toBe(false)

    expect(autostart.disable).toHaveBeenCalledOnce()
    expect(store.setAutostartPreference).toHaveBeenCalledWith('disabled')
  })

  it('rejects a toggle change the operating system did not apply', async () => {
    const store = createPreferenceStore('enabled')
    autostart.isEnabled.mockResolvedValue(true)

    await expect(setLaunchAtStartup(store, false)).rejects.toThrow(
      'Operating system did not apply launch-at-startup setting'
    )
    expect(store.setAutostartPreference).not.toHaveBeenCalled()
  })
})

describe('launch at startup across the product rename', () => {
  beforeEach(() => {
    vi.clearAllMocks()
  })

  it('re-registers under the new name when the old entry existed', async () => {
    const store = createPreferenceStore('unmanaged')
    const removeLegacyEntry = vi.fn().mockResolvedValue(true)
    autostart.isEnabled.mockResolvedValue(false)

    await expect(
      carryLaunchAtStartupAcrossRename(store, removeLegacyEntry)
    ).resolves.toBe(true)

    expect(removeLegacyEntry).toHaveBeenCalledOnce()
    expect(autostart.enable).toHaveBeenCalledOnce()
  })

  it('re-registers when the old uninstaller already removed the entry but it was on', async () => {
    const store = createPreferenceStore('enabled')
    autostart.isEnabled.mockResolvedValue(false)

    await expect(
      carryLaunchAtStartupAcrossRename(store, vi.fn().mockResolvedValue(false))
    ).resolves.toBe(true)

    expect(autostart.enable).toHaveBeenCalledOnce()
  })

  it('leaves launch at startup off for a user who never turned it on', async () => {
    const store = createPreferenceStore('disabled')
    autostart.isEnabled.mockResolvedValue(false)

    await expect(
      carryLaunchAtStartupAcrossRename(store, vi.fn().mockResolvedValue(false))
    ).resolves.toBe(false)

    expect(autostart.enable).not.toHaveBeenCalled()
  })

  it('does not register twice when the new entry is already there', async () => {
    const store = createPreferenceStore('enabled')
    autostart.isEnabled.mockResolvedValue(true)

    await expect(
      carryLaunchAtStartupAcrossRename(store, vi.fn().mockResolvedValue(true))
    ).resolves.toBe(false)

    expect(autostart.enable).not.toHaveBeenCalled()
  })
})
