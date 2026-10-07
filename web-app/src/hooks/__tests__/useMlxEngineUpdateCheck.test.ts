import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// Task 6.3 of move-sdcpp-mlx-install-to-core: "Check engine updates" on the MLX
// provider page asks the core through mlx-extension, which publishes the
// banner's offer; the page only says what came of it.

const toast = vi.hoisted(() => ({ success: vi.fn(), info: vi.fn(), error: vi.fn() }))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))
const checkForEngineUpdate = vi.fn()
const getByName = vi.fn()
vi.mock('@/lib/extension', () => ({
  ExtensionManager: { getInstance: () => ({ getByName }) },
}))

import { describeMlxBuild, useMlxEngineUpdateCheck } from '../useMlxEngineUpdateCheck'

describe('useMlxEngineUpdateCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    getByName.mockReturnValue({ checkForEngineUpdate })
  })

  it('re-reads the manifest through mlx-extension and points at the banner when a build is newer', async () => {
    checkForEngineUpdate.mockResolvedValue({
      updateAvailable: true,
      targetVersion: 'mlxvlm-macos-arm64-abc1234',
    })
    const { result } = renderHook(() => useMlxEngineUpdateCheck())
    await act(() => result.current.check())

    expect(getByName).toHaveBeenCalledWith('@janhq/mlx-extension')
    expect(checkForEngineUpdate).toHaveBeenCalledWith({ force: true })
    expect(toast.info).toHaveBeenCalledWith(
      'settings:mlxEngine.updateAvailable {"version":"mlxvlm-macos-arm64-abc1234"}'
    )
    expect(result.current.checking).toBe(false)
  })

  it('says the build is current when the core names none', async () => {
    checkForEngineUpdate.mockResolvedValue({ updateAvailable: false, targetVersion: null })
    const { result } = renderHook(() => useMlxEngineUpdateCheck())
    await act(() => result.current.check())
    expect(toast.success).toHaveBeenCalledWith('settings:mlxEngine.upToDate')
    expect(toast.info).not.toHaveBeenCalled()
    expect(result.current.checking).toBe(false)
  })

  it('reports a check that failed', async () => {
    checkForEngineUpdate.mockRejectedValue({ code: 'UPSTREAM_ERROR', message: 'offline' })
    const { result } = renderHook(() => useMlxEngineUpdateCheck())
    await act(() => result.current.check())
    expect(toast.error).toHaveBeenCalledWith('settings:mlxEngine.checkFailed', {
      description: 'offline',
    })
    expect(result.current.checking).toBe(false)
  })
})

describe('describeMlxBuild', () => {
  it('splits the version setting into the tag and where the build came from', () => {
    expect(describeMlxBuild('mlxvlm-macos-arm64-abc1234/bundled')).toEqual({
      tag: 'mlxvlm-macos-arm64-abc1234',
      origin: 'bundled',
    })
    expect(describeMlxBuild('mlxvlm-macos-arm64-abc1234/downloaded')?.origin).toBe('downloaded')
    // Before the core answered, or an older extension's `<tag> / macos-arm64`.
    expect(describeMlxBuild('detecting...')).toBeNull()
    expect(describeMlxBuild('none')).toBeNull()
    expect(describeMlxBuild('07ba5a1 / macos-arm64')).toBeNull()
  })
})
