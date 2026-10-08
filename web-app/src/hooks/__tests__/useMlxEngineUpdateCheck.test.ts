import { act, renderHook } from '@testing-library/react'
import { beforeEach, describe, expect, it, vi } from 'vitest'

// "Check engine updates" on the MLX provider page asks the core again with
// every source re-read (the engine versions store); the banner offers what it
// finds, and the page only says what came of it.

const toast = vi.hoisted(() => ({
  success: vi.fn(),
  info: vi.fn(),
  error: vi.fn(),
}))
vi.mock('sonner', () => ({ toast }))
vi.mock('@/i18n/react-i18next-compat', () => ({
  useTranslation: () => ({
    t: (key: string, options?: Record<string, unknown>) =>
      options ? `${key} ${JSON.stringify(options)}` : key,
  }),
}))
const engineVersions = vi.fn()
vi.mock('@/services/engines/core', () => ({
  engineVersions: (...args: unknown[]) => engineVersions(...args),
}))

import { useEngineVersionsStore } from '@/stores/engine-versions-store'
import type { EngineVersions } from '@/services/engines/types'
import {
  describeMlxBuild,
  useMlxEngineUpdateCheck,
} from '../useMlxEngineUpdateCheck'

const mlx = (patch: Partial<EngineVersions> = {}): EngineVersions => ({
  engine: 'mlx',
  kind: 'engine-build',
  active_choice: 'core',
  builds: [],
  active: { version: 'mlxvlm-macos-arm64-07ba5a1', variant: 'macos-arm64' },
  latest: null,
  update: { needed: false, target: null, apply: 'swap' },
  source: 'remote',
  source_error: null,
  error: null,
  ...patch,
})

describe('useMlxEngineUpdateCheck', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    useEngineVersionsStore.getState().reset()
  })

  it('asks the core with every source re-read and points at the banner when a build is newer', async () => {
    engineVersions.mockResolvedValue({
      engines: [
        mlx({
          update: {
            needed: true,
            target: {
              version: 'mlxvlm-macos-arm64-abc1234',
              variant: 'macos-arm64',
            },
            apply: 'swap',
          },
        }),
      ],
    })
    const { result } = renderHook(() => useMlxEngineUpdateCheck())
    await act(() => result.current.check())

    expect(engineVersions).toHaveBeenCalledWith(
      expect.objectContaining({ force: true })
    )
    expect(toast.info).toHaveBeenCalledWith(
      'settings:mlxEngine.updateAvailable {"version":"mlxvlm-macos-arm64-abc1234"}'
    )
    expect(result.current.checking).toBe(false)
  })

  it('says the build is current when the core offers none', async () => {
    engineVersions.mockResolvedValue({ engines: [mlx()] })
    const { result } = renderHook(() => useMlxEngineUpdateCheck())
    await act(() => result.current.check())
    expect(toast.success).toHaveBeenCalledWith('settings:mlxEngine.upToDate')
    expect(toast.info).not.toHaveBeenCalled()
    expect(result.current.checking).toBe(false)
  })

  it('reports a check that failed, for the whole answer or for MLX alone', async () => {
    engineVersions.mockRejectedValue({
      code: 'CORE_UNREACHABLE',
      message: 'offline',
    })
    const { result } = renderHook(() => useMlxEngineUpdateCheck())
    await act(() => result.current.check())
    expect(toast.error).toHaveBeenLastCalledWith(
      'settings:mlxEngine.checkFailed',
      {
        description: 'offline',
      }
    )

    engineVersions.mockResolvedValue({
      engines: [
        mlx({
          error: { code: 'UPSTREAM_ERROR', message: 'manifest unreachable' },
        }),
      ],
    })
    await act(() => result.current.check())
    expect(toast.error).toHaveBeenLastCalledWith(
      'settings:mlxEngine.checkFailed',
      {
        description: 'manifest unreachable',
      }
    )
    expect(toast.success).not.toHaveBeenCalled()
    expect(result.current.checking).toBe(false)
  })
})

describe('describeMlxBuild', () => {
  it('splits the version setting into the tag and where the build came from', () => {
    expect(describeMlxBuild('mlxvlm-macos-arm64-abc1234/bundled')).toEqual({
      tag: 'mlxvlm-macos-arm64-abc1234',
      origin: 'bundled',
    })
    expect(
      describeMlxBuild('mlxvlm-macos-arm64-abc1234/downloaded')?.origin
    ).toBe('downloaded')
    // Before the core answered, or an older extension's `<tag> / macos-arm64`.
    expect(describeMlxBuild('detecting...')).toBeNull()
    expect(describeMlxBuild('none')).toBeNull()
    expect(describeMlxBuild('07ba5a1 / macos-arm64')).toBeNull()
  })
})
