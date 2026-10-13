import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  assertDeletableBackendPack,
  isTurboQuantRelease,
  isStableReleaseTag,
  compareBackendVersions,
  satisfiesMinAppVersion,
  defaultAssetName,
  mergeBackendOptions,
} from '../backend'
import { fs, getJanDataFolderPath } from '@janhq/core'
import type { CoreBackendCatalog } from '../adapter/coreRuntime'

// Mock constants: Hardcode path string directly inside the mock to avoid hoisting issues
const MOCK_JAN_PATH_STRING = '/path/to/jan'

// Mock the core dependencies
vi.mock('@janhq/core', () => ({
  getJanDataFolderPath: vi.fn().mockResolvedValue('/path/to/jan'),
  fs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn().mockResolvedValue([]),
    readFileSync: vi.fn().mockResolvedValue(''),
    writeFileSync: vi.fn().mockResolvedValue(undefined),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  joinPath: vi.fn(async (paths: string[]) => paths.join('/')),
  events: {
    emit: vi.fn(),
  },
}))
vi.mock('@tauri-apps/api/app', () => ({
  getVersion: vi.fn().mockResolvedValue('1.0.0'),
}))
vi.mock('../util', () => ({
  getProxyConfig: vi.fn(() => undefined),
}))
// The catalog comes from the core (ADR 2026-09-27); nothing here fetches an index.
vi.mock('../adapter/coreRuntime', () => ({
  getBackendCatalog: vi.fn(),
}))
vi.mock(
  '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index')
    >('../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index')
    return {
      ...actual,
      getLocalInstalledBackendsInternal: vi.fn(),
    }
  }
)

vi.stubGlobal('IS_WINDOWS', false)

describe('Backend functions', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    // Mock getJanDataFolderPath explicitly to a simple path
    vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')

    // Default mock for isBackendInstalled dependencies
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
      if (path.includes('build')) return true
      return false
    })
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('getBackendDir and getBackendExePath', () => {
    it('should use the specific backend name for directory path', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('linux-avx2-x64', 'v1.2.3')
      expect(dir).toBe(`/path/to/jan/llamacpp/backends/v1.2.3/linux-avx2-x64`)

      const exePath = await getBackendExePath('linux-avx2-x64', 'v1.2.3')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp/backends/v1.2.3/linux-avx2-x64/build/bin/llama-server`
      )
    })

    it('should use the new common backend name for directory path if it was the asset name', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('win-common_cpus-x64', 'v2.0.0')
      expect(dir).toBe(
        `/path/to/jan/llamacpp/backends/v2.0.0/win-common_cpus-x64`
      )

      const exePath = await getBackendExePath('win-common_cpus-x64', 'v2.0.0')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp/backends/v2.0.0/win-common_cpus-x64/build/bin/llama-server`
      )
    })
  })

  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `/path/to/jan/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `/path/to/jan/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })
  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })

  describe('isBackendInstalled (Windows DLL completeness check)', () => {
    afterEach(() => {
      vi.stubGlobal('IS_WINDOWS', false)
    })

    it('returns true on Windows when the exe and at least one DLL are present', async () => {
      vi.stubGlobal('IS_WINDOWS', true)
      const exeDir = `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/windows-x64-cpu/build/bin`
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        if (path.endsWith('/build')) return true
        return path === `${exeDir}/llama-server.exe`
      })
      vi.mocked(fs.readdirSync).mockResolvedValue([
        `${exeDir}/llama-server.exe`,
        `${exeDir}/llama-server-impl.dll`,
        `${exeDir}/ggml-cpu.dll`,
      ])

      const result = await isBackendInstalled('windows-x64-cpu', 'v1.0.0')
      expect(result).toBe(true)
    })

    it('returns false on Windows when the exe exists but no DLLs are alongside it (broken install)', async () => {
      vi.stubGlobal('IS_WINDOWS', true)
      const exeDir = `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/windows-x64-cpu/build/bin`
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        if (path.endsWith('/build')) return true
        return path === `${exeDir}/llama-server.exe`
      })
      // Only the exe was relocated into build/bin - CI packaging regression,
      // its dependency DLLs never made it (the root cause this check exists for)
      vi.mocked(fs.readdirSync).mockResolvedValue([
        `${exeDir}/llama-server.exe`,
      ])

      const result = await isBackendInstalled('windows-x64-cpu', 'v1.0.0')
      expect(result).toBe(false)
    })

    it('does not check for DLLs on non-Windows platforms', async () => {
      vi.stubGlobal('IS_WINDOWS', false)
      const exeDir = `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/linux-x64-vulkan/build/bin`
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        if (path.endsWith('/build')) return true
        return path === `${exeDir}/llama-server`
      })
      vi.mocked(fs.readdirSync).mockResolvedValue([`${exeDir}/llama-server`])

      const result = await isBackendInstalled('linux-x64-vulkan', 'v1.0.0')
      expect(result).toBe(true)
      expect(fs.readdirSync).not.toHaveBeenCalled()
    })

    it('fails open (treats as installed) when the directory cannot be enumerated', async () => {
      vi.stubGlobal('IS_WINDOWS', true)
      const exeDir = `${MOCK_JAN_PATH_STRING}/llamacpp/backends/v1.0.0/windows-x64-cpu/build/bin`
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        if (path.endsWith('/build')) return true
        return path === `${exeDir}/llama-server.exe`
      })
      vi.mocked(fs.readdirSync).mockRejectedValue(
        new Error('permission denied')
      )

      const result = await isBackendInstalled('windows-x64-cpu', 'v1.0.0')
      expect(result).toBe(true)
    })

    it('returns false without checking DLLs when the exe itself is missing', async () => {
      vi.stubGlobal('IS_WINDOWS', true)
      vi.mocked(fs.existsSync).mockResolvedValue(false)

      const result = await isBackendInstalled('windows-x64-cpu', 'v1.0.0')
      expect(result).toBe(false)
      expect(fs.readdirSync).not.toHaveBeenCalled()
    })
  })

  describe('TurboQuant asset names', () => {
    afterEach(() => {
      vi.stubGlobal('IS_WINDOWS', false)
    })

    it('derives the archive extension from the backend id, not the host', () => {
      vi.stubGlobal('IS_WINDOWS', false)
      expect(defaultAssetName('windows-x64-cuda-13.3')).toBe(
        'llama-turboquant-windows-x64-cuda-13.3.zip'
      )
      expect(defaultAssetName('macos-arm64')).toBe(
        'llama-turboquant-macos-arm64.tar.gz'
      )
    })
  })
})

describe('isTurboQuantRelease', () => {
  it('accepts both the unified tag and the legacy per-backend tags', () => {
    expect(isTurboQuantRelease('b10018-1.3.0')).toBe(true)
    expect(isTurboQuantRelease('b10018-1.3.0/linux-x64-rocm')).toBe(true)
    expect(isTurboQuantRelease('turboquant-linux-x64-vulkan-d86eb0b')).toBe(
      true
    )
  })

  it('rejects stock upstream builds so fork-only flags stay contained', () => {
    expect(isTurboQuantRelease('b10018')).toBe(false)
    expect(isTurboQuantRelease('b10205/win-cuda-13.3-x64')).toBe(false)
    expect(isTurboQuantRelease('')).toBe(false)
  })
})

describe('assertDeletableBackendPack', () => {
  it('returns the cleaned ids of a build that is not selected', () => {
    expect(
      assertDeletableBackendPack(
        'b10018-1.3.0/windows-x64-cpu',
        '﻿b9937-1.2.0 ',
        ' windows-x64-cuda-13.3'
      )
    ).toEqual({ version: 'b9937-1.2.0', backend: 'windows-x64-cuda-13.3' })
  })

  it('refuses the selected build, whatever BOM or whitespace it carries', () => {
    expect(() =>
      assertDeletableBackendPack(
        '﻿b10018-1.3.0/windows-x64-cpu',
        'b10018-1.3.0',
        'windows-x64-cpu '
      )
    ).toThrow('Cannot remove the backend that is currently selected')
  })

  it('refuses ids that could leave the pack directory', () => {
    for (const [version, backend] of [
      ['', 'windows-x64-cpu'],
      ['b10018-1.3.0', '  '],
      ['../b10018', 'windows-x64-cpu'],
      ['b10018-1.3.0', 'windows\\x64'],
      ['..', 'windows-x64-cpu'],
      ['b10018-1.3.0', '.'],
    ]) {
      expect(() => assertDeletableBackendPack('', version, backend)).toThrow(
        'Invalid backend pack'
      )
    }
  })
})

describe('stable release tags', () => {
  it('accepts only the unified release scheme', () => {
    expect(isStableReleaseTag('b10269-1.4.0')).toBe(true)
    expect(isStableReleaseTag('b10269-1.4.0/linux-x64-rocm')).toBe(true)
    expect(isStableReleaseTag('﻿ b10269-1.4.0 ')).toBe(true)
  })

  it('rejects prereleases, including the legacy per-variant tags', () => {
    expect(isStableReleaseTag('turboquant-linux-x64-vulkan-d86eb0b')).toBe(
      false
    )
    expect(isStableReleaseTag('dev-latest')).toBe(false)
    expect(isStableReleaseTag('b10205')).toBe(false)
    expect(isStableReleaseTag('')).toBe(false)
    // Reached with an absent `config.version_backend` on a fresh profile.
    expect(isStableReleaseTag(undefined as unknown as string)).toBe(false)
    expect(
      compareBackendVersions(
        undefined as unknown as string,
        undefined as unknown as string
      )
    ).toBe(0)
  })

  it('orders releases by build then fork semver, stable over legacy', () => {
    // b9937 < b10018 numerically, which string ordering gets backwards.
    expect(
      compareBackendVersions('b10018-1.3.0', 'b9937-1.2.0')
    ).toBeGreaterThan(0)
    expect(
      compareBackendVersions('b10269-1.4.0', 'b10269-1.3.9')
    ).toBeGreaterThan(0)
    expect(compareBackendVersions('b10018-1.3.0', 'b10018-1.3.0')).toBe(0)
    expect(
      compareBackendVersions('b10018-1.3.0', 'turboquant-macos-arm64-e3dad20')
    ).toBeGreaterThan(0)
    // Two legacy SHAs carry no order at all — neither supersedes the other.
    expect(
      compareBackendVersions(
        'turboquant-macos-arm64-e3dad20',
        'turboquant-macos-arm64-18a8ef1'
      )
    ).toBe(0)
  })
})

// Kept for callers that still hold a reference; the core applies the gate.
describe('satisfiesMinAppVersion', () => {
  it('lets a new enough app through and holds an old one back', () => {
    expect(satisfiesMinAppVersion('1.2.0', '1.3.0')).toBe(true)
    expect(satisfiesMinAppVersion('1.2.0', '1.2.0')).toBe(true)
    expect(satisfiesMinAppVersion('1.3.0', '1.2.9')).toBe(false)
    expect(satisfiesMinAppVersion('1.3.0', '1.3.0-beta.2')).toBe(true)
  })

  it('passes when the requirement or the app version is unknown', () => {
    expect(satisfiesMinAppVersion(undefined, '1.0.0')).toBe(true)
    expect(satisfiesMinAppVersion('not-a-version', '1.0.0')).toBe(true)
    expect(satisfiesMinAppVersion('9.9.9', null)).toBe(true)
  })
})

/// The release index, the hardware gate and the merge with what is on disk
/// moved to the core (ADR 2026-09-27) and are tested there; this side only
/// has to hand the core's catalog out under the names the extension already
/// used, and ask once.
describe('catalog wrappers over the core', () => {
  const LATEST = 'b10269-1.4.0'
  const PREVIOUS = 'b10018-1.3.0'

  const CATALOG: CoreBackendCatalog = {
    provider: 'llamacpp',
    os_type: 'linux',
    arch_suffix: 'x64',
    hardware_source: 'probe',
    features: { vulkan: true },
    supported_backends: ['linux-x64-cpu', 'linux-x64-vulkan'],
    remote: [
      { version: LATEST, backend: 'linux-x64-cpu', order: 0 },
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ],
    installed: [
      { version: 'turboquant-linux-x64-vulkan-d86eb0b', backend: 'linux', order: 1 },
    ],
    available: [
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: LATEST, backend: 'linux-x64-cpu', order: 0 },
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
      { version: 'turboquant-linux-x64-vulkan-d86eb0b', backend: 'linux', order: 1 },
    ],
    recommended: `${LATEST}/linux-x64-vulkan`,
    recommended_installed: 'turboquant-linux-x64-vulkan-d86eb0b/linux',
    latest_by_type: {
      'linux-x64-vulkan': `${LATEST}/linux-x64-vulkan`,
      'linux-x64-cpu': `${LATEST}/linux-x64-cpu`,
    },
    static_variants: [],
    source: 'index',
    releases: [
      {
        tag: LATEST,
        title: `TurboQuant ${LATEST}`,
        highlights: ['DeepSeek V4 Flash support'],
        variants: [
          {
            id: 'linux-x64-vulkan',
            asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
            size: 120_000_000,
          },
          { id: 'linux-x64-cpu', asset: 'llama-turboquant-linux-x64-cpu.tar.gz' },
        ],
      },
      {
        tag: PREVIOUS,
        variants: [
          {
            id: 'linux-x64-vulkan',
            asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
            size: 0,
          },
        ],
      },
    ],
  }

  type BackendModule = typeof import('../backend')
  let backend: BackendModule
  let getBackendCatalog: ReturnType<typeof vi.fn>

  // The module memoizes the catalog, so every test starts from a cold module.
  beforeEach(async () => {
    vi.resetModules()
    backend = await import('../backend')
    const adapter = await import('../adapter/coreRuntime')
    getBackendCatalog = vi.mocked(adapter.getBackendCatalog) as unknown as ReturnType<typeof vi.fn>
    getBackendCatalog.mockReset()
    getBackendCatalog.mockResolvedValue(CATALOG)
    // Earlier suites restore every mock, which strips the factory's answer.
    const { getVersion } = await import('@tauri-apps/api/app')
    vi.mocked(getVersion).mockResolvedValue('1.0.0')
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('asks the core with the app version, no proxy and no force by default', async () => {
    const catalog = await backend.loadCatalog()

    expect(catalog).toEqual(CATALOG)
    expect(getBackendCatalog).toHaveBeenCalledTimes(1)
    expect(getBackendCatalog).toHaveBeenCalledWith({
      app_version: '1.0.0',
      proxy: null,
      force: false,
    })
  })

  it('fetchStableIndex reflects the releases the core resolved, newest first', async () => {
    await expect(backend.fetchStableIndex()).resolves.toEqual({
      latest: LATEST,
      releases: CATALOG.releases,
      source: 'index',
    })
  })

  it('fetchRemoteBackends is the remote list, listSupportedBackends the available one', async () => {
    await expect(backend.fetchRemoteBackends()).resolves.toEqual(CATALOG.remote)
    await expect(backend.listSupportedBackends()).resolves.toEqual(
      CATALOG.available
    )
    // Three readers, one question.
    expect(getBackendCatalog).toHaveBeenCalledTimes(1)
  })

  it('memoizes the answer until something asks to force', async () => {
    await backend.fetchStableIndex()
    await backend.listSupportedBackends()
    expect(getBackendCatalog).toHaveBeenCalledTimes(1)

    await backend.listSupportedBackends({ force: true })
    expect(getBackendCatalog).toHaveBeenCalledTimes(2)
    expect(getBackendCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true })
    )

    // An explicit invalidation forces the next read, and only that one.
    backend.invalidateStableIndexCache()
    expect(backend.catalogSnapshot()).toBeNull()
    await backend.fetchRemoteBackends()
    await backend.fetchRemoteBackends()
    expect(getBackendCatalog).toHaveBeenCalledTimes(3)
    expect(getBackendCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: true })
    )
  })

  it('asks the core again on refresh without forcing a refetch of the release index', async () => {
    // A backend installed from a file never passes through the core; only a new answer sees it.
    await backend.loadCatalog()
    await backend.loadCatalog({ refresh: true })
    expect(getBackendCatalog).toHaveBeenCalledTimes(2)
    expect(getBackendCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: false })
    )
    await backend.loadCatalog()
    expect(getBackendCatalog).toHaveBeenCalledTimes(2)
  })

  it('shares one in-flight request between concurrent readers', async () => {
    let release!: (catalog: CoreBackendCatalog) => void
    getBackendCatalog.mockReturnValue(
      new Promise<CoreBackendCatalog>((resolve) => {
        release = resolve
      })
    )

    const pending = Promise.all([
      backend.fetchStableIndex(),
      backend.fetchRemoteBackends(),
      backend.listSupportedBackends(),
    ])
    release(CATALOG)
    const [index, remote, available] = await pending

    expect(getBackendCatalog).toHaveBeenCalledTimes(1)
    expect(index.latest).toBe(LATEST)
    expect(remote).toEqual(CATALOG.remote)
    expect(available).toEqual(CATALOG.available)
  })

  it('reads asset names off the memoized catalog', async () => {
    // Cold: no catalog yet, so the naming convention takes over upstream.
    expect(
      backend.getIndexedAssetName(LATEST, 'linux-x64-vulkan')
    ).toBeUndefined()

    await backend.loadCatalog()

    expect(backend.getIndexedAssetName(`﻿${LATEST} `, 'linux-x64-vulkan')).toBe(
      'llama-turboquant-linux-x64-vulkan.tar.gz'
    )
    expect(backend.getIndexedAssetName(LATEST, 'linux-x64-rocm')).toBeUndefined()
  })

  it('treats a core without a release index as an empty one', async () => {
    getBackendCatalog.mockResolvedValue({
      ...CATALOG,
      releases: undefined,
      source: 'none',
    })

    await expect(backend.fetchStableIndex()).resolves.toEqual({
      latest: null,
      releases: [],
      source: 'none',
    })
  })

  describe('when the core does not answer', () => {
    beforeEach(() => {
      getBackendCatalog.mockRejectedValue(new Error('core unreachable'))
    })

    it('fetchStableIndex and fetchRemoteBackends fall back to local backends only', async () => {
      await expect(backend.fetchStableIndex()).resolves.toEqual({
        latest: null,
        releases: [],
        source: 'none',
      })
      await expect(backend.fetchRemoteBackends()).resolves.toEqual([])
    })

    it('listSupportedBackends throws so configureBackends can keep the bundled build', async () => {
      await expect(backend.listSupportedBackends()).rejects.toThrow(
        'core unreachable'
      )
      expect(backend.catalogSnapshot()).toBeNull()
    })

    it('asks again on the next read instead of caching the failure', async () => {
      await backend.fetchRemoteBackends()
      getBackendCatalog.mockResolvedValue(CATALOG)

      await expect(backend.fetchRemoteBackends()).resolves.toEqual(CATALOG.remote)
      expect(getBackendCatalog).toHaveBeenCalledTimes(2)
    })
  })
})

describe('mergeBackendOptions', () => {
  const catalog = [
    { value: 'b10269-1.5.1/macos-arm64', name: 'Apple Silicon · 1.5.1' },
    { value: 'b10269-1.5.0/macos-arm64', name: 'Apple Silicon · 1.5.0' },
  ]

  // A prerelease build that left the stable index still runs, so hiding it
  // would mean the dropdown lists fewer versions than the packs dialog does.
  it('keeps an installed build the release index no longer carries', () => {
    const installed = [
      {
        value: 'turboquant-macos-arm64-d785414/macos-arm64',
        name: 'Apple Silicon · d785414 — installed locally',
      },
    ]

    expect(
      mergeBackendOptions([catalog, installed]).map((o) => o.value)
    ).toEqual([
      'b10269-1.5.1/macos-arm64',
      'b10269-1.5.0/macos-arm64',
      'turboquant-macos-arm64-d785414/macos-arm64',
    ])
  })

  it('keeps the catalog label when a build is also installed', () => {
    const installed = [
      {
        value: 'b10269-1.5.1/macos-arm64',
        name: 'Apple Silicon · 1.5.1 — installed locally',
      },
    ]

    const merged = mergeBackendOptions([catalog, installed])
    expect(merged.map((o) => o.name)).toEqual([
      'Apple Silicon · 1.5.1',
      'Apple Silicon · 1.5.0',
    ])
  })

  it('forces a recommendation the tiers missed into the list', () => {
    const merged = mergeBackendOptions([catalog], {
      value: 'b10300-1.6.0/macos-arm64',
      name: 'Apple Silicon · 1.6.0',
    })

    expect(merged[0]).toEqual({
      value: 'b10300-1.6.0/macos-arm64',
      name: 'Apple Silicon · 1.6.0',
    })
  })

  it('drops blank ids and the BOM a manifest read can leave behind', () => {
    const merged = mergeBackendOptions([
      [
        { value: '  ', name: 'blank' },
        { value: '﻿b10269-1.5.1/macos-arm64', name: 'bom' },
        { value: 'b10269-1.5.1/macos-arm64', name: 'clean' },
      ],
    ])

    expect(merged).toEqual([{ value: 'b10269-1.5.1/macos-arm64', name: 'bom' }])
  })
})
