import { beforeEach, describe, expect, it, vi } from 'vitest'

const core = vi.hoisted(() => ({
  engineBuildCatalog: vi.fn(),
  engineBuildProxy: vi.fn(() => undefined),
}))
vi.mock('../core', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../core')>()),
  ...core,
}))
const install = vi.hoisted(() => ({ installEngineBuildWithProgress: vi.fn() }))
vi.mock('../install', async (importOriginal) => ({
  ...(await importOriginal<typeof import('../install')>()),
  ...install,
}))

import type { EngineVersions } from '@/services/engines/types'
import { useEngineVersionsStore } from '@/stores/engine-versions-store'

import {
  installMlxEngine,
  mlxEngineActive,
  mlxEngineActiveIn,
  pendingMlxEngineInstall,
  useMlxEngineInstallStore,
} from '../mlx'
import type { EngineBuildCatalog } from '../types'

const catalog = (
  over: Partial<EngineBuildCatalog> = {}
): EngineBuildCatalog => ({
  engine: 'mlx',
  manifest: {
    tag: 'mlxvlm-macos-arm64-abc1234',
    source: 'remote',
    fetched_at: 1,
    error: null,
  },
  manifest_error: null,
  host_backend_id: 'macos-arm64',
  host_reason: null,
  installed: [],
  active: null,
  ...over,
})

const RESULT = {
  installed: true,
  build: {
    tag: 'mlxvlm-macos-arm64-abc1234',
    backend_id: 'macos-arm64',
    origin: 'downloaded' as const,
  },
  retired: [],
  kept_in_use: [],
}

const versions = (over: Partial<EngineVersions> = {}): EngineVersions => ({
  engine: 'mlx',
  kind: 'engine-build',
  active_choice: 'core',
  builds: [],
  active: null,
  latest: { version: 'mlxvlm-macos-arm64-abc1234', variant: 'macos-arm64' },
  update: { needed: false, target: null, apply: 'swap' },
  source: 'remote',
  source_error: null,
  error: null,
  ...over,
})

const refresh = vi.fn(async () => {})

beforeEach(() => {
  vi.clearAllMocks()
  useEngineVersionsStore.setState({ engines: {}, refresh })
  useMlxEngineInstallStore.setState({ installing: false, progress: null })
})

describe('installMlxEngine', () => {
  it("installs this Mac's build under its own download row, then reads the versions again", async () => {
    core.engineBuildCatalog.mockResolvedValue(catalog())
    install.installEngineBuildWithProgress.mockResolvedValue(RESULT)

    await expect(installMlxEngine()).resolves.toBe(RESULT)

    expect(install.installEngineBuildWithProgress).toHaveBeenCalledWith(
      'mlx',
      expect.objectContaining({
        taskId: 'engine-build-mlx-mlxvlm-macos-arm64-abc1234',
      })
    )
    expect(refresh).toHaveBeenCalledTimes(1)
    expect(useMlxEngineInstallStore.getState().installing).toBe(false)
  })

  it('refuses a Mac with no build with the core’s reason, before any download', async () => {
    core.engineBuildCatalog.mockResolvedValue(
      catalog({
        host_backend_id: null,
        host_reason: 'MLX needs Apple silicon.',
      })
    )

    await expect(installMlxEngine()).rejects.toEqual({
      code: 'UNSUPPORTED_BACKEND',
      message: 'MLX needs Apple silicon.',
    })
    expect(install.installEngineBuildWithProgress).not.toHaveBeenCalled()
    expect(useMlxEngineInstallStore.getState().installing).toBe(false)
  })

  it('reports a manifest it could not read as UPSTREAM_ERROR, before any download', async () => {
    core.engineBuildCatalog.mockResolvedValue(
      catalog({
        manifest: null,
        manifest_error: 'conf unreachable',
        host_backend_id: null,
      })
    )

    await expect(installMlxEngine()).rejects.toEqual({
      code: 'UPSTREAM_ERROR',
      message: 'conf unreachable',
    })
    expect(install.installEngineBuildWithProgress).not.toHaveBeenCalled()
  })

  it('runs one install for every call made while it runs', async () => {
    core.engineBuildCatalog.mockResolvedValue(catalog())
    let finish!: (value: typeof RESULT) => void
    install.installEngineBuildWithProgress.mockImplementation(
      (
        _engine: string,
        options: {
          onProgress?: (p: { transferred: number; total: number }) => void
        }
      ) => {
        options.onProgress?.({ transferred: 5, total: 10 })
        return new Promise((resolve) => (finish = resolve))
      }
    )

    expect(pendingMlxEngineInstall()).toBeNull()
    const first = installMlxEngine()
    const second = installMlxEngine()
    expect(second).toBe(first)
    // A load can join it without starting another.
    expect(pendingMlxEngineInstall()).toBe(first)
    expect(useMlxEngineInstallStore.getState().installing).toBe(true)
    await vi.waitFor(() =>
      expect(install.installEngineBuildWithProgress).toHaveBeenCalledTimes(1)
    )
    expect(useMlxEngineInstallStore.getState().progress).toEqual({
      transferred: 5,
      total: 10,
    })

    finish(RESULT)
    await expect(Promise.all([first, second])).resolves.toEqual([
      RESULT,
      RESULT,
    ])
    expect(core.engineBuildCatalog).toHaveBeenCalledTimes(1)
    expect(pendingMlxEngineInstall()).toBeNull()
    expect(useMlxEngineInstallStore.getState()).toMatchObject({
      installing: false,
      progress: null,
    })

    // Over: the next call installs again.
    install.installEngineBuildWithProgress.mockResolvedValue(RESULT)
    await installMlxEngine()
    expect(install.installEngineBuildWithProgress).toHaveBeenCalledTimes(2)
  })
})

describe('whether MLX has an active build', () => {
  it('reads the core’s versions answer', () => {
    expect(
      mlxEngineActiveIn(
        versions({ active: { version: 'v1', variant: 'macos-arm64' } })
      )
    ).toBe(true)
    expect(mlxEngineActiveIn(versions())).toBe(false)
    // An unreachable manifest still reports what is on disk.
    expect(
      mlxEngineActiveIn(
        versions({
          source: null,
          source_error: 'offline',
          error: { code: 'UPSTREAM_ERROR', message: 'offline' },
        })
      )
    ).toBe(false)
  })

  it('says nothing without an answer, or when the read failed outright', () => {
    expect(mlxEngineActiveIn(undefined)).toBeNull()
    expect(
      mlxEngineActiveIn(
        versions({ error: { code: 'INTERNAL_ERROR', message: 'boom' } })
      )
    ).toBeNull()
  })

  it('asks the core again before answering', async () => {
    refresh.mockImplementationOnce(async () => {
      useEngineVersionsStore.setState({ engines: { mlx: versions() } })
    })
    await expect(mlxEngineActive()).resolves.toBe(false)
    expect(refresh).toHaveBeenCalledTimes(1)
  })
})
