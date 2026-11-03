import { beforeEach, describe, expect, it, vi } from 'vitest'
import { useInterfaceSettings } from '../useInterfaceSettings'
import { useTheme } from '../useTheme'
import { localStorageKey } from '@/constants/localStorage'
import { seedServiceHub } from '@/test/service-hub'

describe('interface reset and the persisted theme', () => {
  const setTheme = vi.fn(async () => {})

  beforeEach(() => {
    localStorage.clear()
    setTheme.mockReset().mockResolvedValue(undefined)
    seedServiceHub({
      theme: { setTheme, getCurrentWindow: () => ({ setTheme }) },
    })
    useTheme.setState({ activeTheme: 'dark', isDark: true })
    useInterfaceSettings.getState().setFontSize('20px')
  })

  it('restores System and keeps it after rehydrating settings', async () => {
    await useInterfaceSettings.getState().resetInterface()
    expect(setTheme).toHaveBeenCalledWith(null)
    expect(useTheme.getState().activeTheme).toBe('auto')
    expect(
      JSON.parse(localStorage.getItem(localStorageKey.theme)!).state.activeTheme
    ).toBe('auto')
    await useTheme.persist.rehydrate()
    expect(useTheme.getState().activeTheme).toBe('auto')
    expect(useInterfaceSettings.getState().fontSize).toBe('13px')
  })

  it('rejects a failed native reset without claiming the theme changed', async () => {
    setTheme.mockRejectedValueOnce(new Error('Theme unavailable'))
    await expect(
      useInterfaceSettings.getState().resetInterface()
    ).rejects.toThrow('Theme unavailable')
    expect(useTheme.getState().activeTheme).toBe('dark')
    expect(useInterfaceSettings.getState().fontSize).toBe('20px')
  })
})
