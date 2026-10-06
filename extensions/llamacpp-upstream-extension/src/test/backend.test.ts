import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  fetchRemoteBackends,
  listSupportedBackends,
  loadCatalog,
  catalogSnapshot,
  parseVersionBackendSetting,
  getBackendArchiveName,
  getBackendDownloadUrl,
  BUNDLED_BASELINE_TAG,
  resolveGpuFamilyConcrete,
  isConcreteOfGpuFamily,
  friendlyBackendLabel,
  cudaFamilyMajor,
  requiredDiskSpaceForBackend,
  listInstalledBackendPacks,
  deleteBackendPack,
  mergeBackendOptions,
  cleanupIncompleteBackends,
} from '../backend'
import { BUNDLED_MANIFEST_BASELINE } from '../bundledManifestBaseline'
import UPSTREAM_MANIFEST_FIXTURE from '../../../../tests/fixtures/registries/upstream-manifest.json'
import { getBackendCatalog } from '../adapter/coreRuntime'
import type { CoreBackendCatalog } from '../adapter/coreRuntime'
import { fs, getJanDataFolderPath } from '@janhq/core'
import { getLocalInstalledBackendsInternal } from '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'

// Mock constants: Hardcode path string directly inside the mock to avoid hoisting issues
const MOCK_JAN_PATH_STRING = '/path/to/jan'

// Mock the core dependencies
vi.mock('@janhq/core', () => ({
  getJanDataFolderPath: vi.fn().mockResolvedValue('/path/to/jan'),
  fs: {
    existsSync: vi.fn(),
    readdirSync: vi.fn().mockResolvedValue([]),
    rm: vi.fn().mockResolvedValue(undefined),
  },
  joinPath: vi.fn(async (paths: string[]) => paths.join('/')),
  events: {
    emit: vi.fn(),
  },
}))
// The catalog is the core's answer (ADR 2026-09-27); this module only asks.
vi.mock('../adapter/coreRuntime', () => ({
  getBackendCatalog: vi.fn(),
}))
vi.mock('../util', () => ({
  getProxyConfig: vi.fn(() => undefined),
}))
// Only the Rust-backed directory scan is stubbed; the pure helpers around it
// stay real.
vi.mock(
  '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index')
    >(
      '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
    )
    return {
      ...actual,
      getLocalInstalledBackendsInternal: vi.fn().mockResolvedValue([]),
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

  describe('getBackendArchiveName', () => {
    it('uses upstream ubuntu tarball names for Linux backend archives', () => {
      expect(getBackendArchiveName('b9691', 'linux-vulkan-x64')).toBe(
        'llama-b9691-bin-ubuntu-vulkan-x64.tar.gz'
      )
      expect(getBackendArchiveName('b9691', 'linux-cpu-x64')).toBe(
        'llama-b9691-bin-ubuntu-x64.tar.gz'
      )
    })

    it('uses upstream ubuntu tarball names for the Linux arm64 builds', () => {
      expect(getBackendArchiveName('b11344', 'linux-cpu-arm64')).toBe(
        'llama-b11344-bin-ubuntu-arm64.tar.gz'
      )
      expect(getBackendArchiveName('b11344', 'linux-vulkan-arm64')).toBe(
        'llama-b11344-bin-ubuntu-vulkan-arm64.tar.gz'
      )
      expect(getBackendArchiveName('b11344', 'linux-cuda-13.4-arm64')).toBe(
        'llama-b11344-bin-ubuntu-cuda-13.4-arm64.tar.gz'
      )
    })

    it('uses upstream tarball names for macOS backend archives', () => {
      expect(getBackendArchiveName('b9702', 'macos-arm64')).toBe(
        'llama-b9702-bin-macos-arm64.tar.gz'
      )
    })

    it('keeps zip archive names for Windows backend archives', () => {
      expect(getBackendArchiveName('b9691', 'win-cpu-x64')).toBe(
        'llama-b9691-bin-win-cpu-x64.zip'
      )
    })

    it('maps supported ids to exact upstream release URLs', () => {
      expect(getBackendDownloadUrl('b10205', 'win-cuda-13.3-x64')).toBe(
        'https://github.com/ggml-org/llama.cpp/releases/download/b10205/llama-b10205-bin-win-cuda-13.3-x64.zip'
      )
      expect(getBackendDownloadUrl('b10205', 'linux-vulkan-x64')).toBe(
        'https://github.com/ggml-org/llama.cpp/releases/download/b10205/llama-b10205-bin-ubuntu-vulkan-x64.tar.gz'
      )
      expect(getBackendDownloadUrl('b9702', 'macos-arm64')).toBe(
        'https://github.com/ggml-org/llama.cpp/releases/download/b9702/llama-b9702-bin-macos-arm64.tar.gz'
      )
      expect(() => getBackendDownloadUrl('latest', 'win-cpu-x64')).toThrow(
        "unresolved 'latest' tag"
      )
    })

    it('resolves the CUDA 13 family to the newest published minor', () => {
      expect(
        resolveGpuFamilyConcrete('win-cuda-13-x64', [
          { version: 'b9900', backend: 'win-cuda-13.1-x64', order: 0 },
          { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
          { version: 'b10205', backend: 'win-cuda-12.4-x64', order: 0 },
        ])
      ).toBe('b10205/win-cuda-13.3-x64')
    })

    it('resolves the arm64 CUDA 13 family only against arm64 assets', () => {
      const remote = [
        { version: 'b11344', backend: 'win-cuda-13.5-x64', order: 0 },
        { version: 'b11344', backend: 'win-cuda-13.4-arm64', order: 0 },
      ]
      expect(resolveGpuFamilyConcrete('win-cuda-13-arm64', remote)).toBe(
        'b11344/win-cuda-13.4-arm64'
      )
      expect(resolveGpuFamilyConcrete('win-cuda-13-x64', remote)).toBe(
        'b11344/win-cuda-13.5-x64'
      )
      expect(
        isConcreteOfGpuFamily('win-cuda-13-arm64', 'win-cuda-13.4-x64')
      ).toBe(false)
    })

    it('resolves the Linux arm64 CUDA 13 family only against Linux arm64 assets', () => {
      const remote = [
        { version: 'b11344', backend: 'win-cuda-13.5-arm64', order: 0 },
        { version: 'b11344', backend: 'linux-cuda-13.4-arm64', order: 0 },
      ]
      expect(resolveGpuFamilyConcrete('linux-cuda-13-arm64', remote)).toBe(
        'b11344/linux-cuda-13.4-arm64'
      )
      expect(
        isConcreteOfGpuFamily('linux-cuda-13-arm64', 'win-cuda-13.5-arm64')
      ).toBe(false)
      expect(cudaFamilyMajor('linux-cuda-13-arm64')).toBe('13')
      expect(cudaFamilyMajor('linux-cuda-13.4-arm64')).toBeNull()
      expect(cudaFamilyMajor('win-cuda-12-x64')).toBe('12')
      expect(friendlyBackendLabel('linux-cuda-13-arm64')).toBe('CUDA 13')
      expect(friendlyBackendLabel('linux-cpu-arm64')).toBe('CPU')
      expect(friendlyBackendLabel('linux-vulkan-arm64')).toBe('Vulkan')
    })

    it('labels the Windows arm64 variants', () => {
      expect(friendlyBackendLabel('win-cpu-arm64')).toBe('CPU')
      expect(friendlyBackendLabel('win-opencl-adreno-arm64')).toBe(
        'OpenCL (Adreno)'
      )
      expect(friendlyBackendLabel('win-cuda-13-arm64')).toBe('CUDA 13')
    })

    it('resolves the version-less ROCm family to the published HIP asset', () => {
      const remote = [
        { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 0 },
        { version: 'b10405', backend: 'win-vulkan-x64', order: 0 },
      ]

      expect(resolveGpuFamilyConcrete('win-rocm-x64', remote)).toBe(
        'b10405/win-rocm-7.14-x64'
      )
      expect(isConcreteOfGpuFamily('win-rocm-x64', 'win-rocm-7.14-x64')).toBe(
        true
      )
      // ROCm and CUDA families must not bleed into each other.
      expect(isConcreteOfGpuFamily('win-rocm-x64', 'win-cuda-13.3-x64')).toBe(
        false
      )
      expect(isConcreteOfGpuFamily('win-cuda-13-x64', 'win-rocm-7.14-x64')).toBe(
        false
      )
    })

    it('picks the highest HIP version when several are published', () => {
      expect(
        resolveGpuFamilyConcrete('win-rocm-x64', [
          { version: 'b10405', backend: 'win-rocm-7.9-x64', order: 0 },
          { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 0 },
        ])
      ).toBe('b10405/win-rocm-7.14-x64')

      // The b10431 -> b10809 bump moves the family from HIP 7.14 to 10.0, so
      // the comparison has to be numeric rather than lexicographic.
      expect(
        resolveGpuFamilyConcrete('win-rocm-x64', [
          { version: 'b10431', backend: 'win-rocm-7.14-x64', order: 0 },
          { version: 'b10809', backend: 'win-rocm-10.0-x64', order: 0 },
        ])
      ).toBe('b10809/win-rocm-10.0-x64')
    })

    it('labels the ROCm variants with their weight', () => {
      expect(friendlyBackendLabel('win-rocm-7.14-x64')).toBe(
        'ROCm 7.14 (~1 GB)'
      )
      expect(friendlyBackendLabel('win-rocm-10.0-x64')).toBe(
        'ROCm 10.0 (~1 GB)'
      )
      expect(friendlyBackendLabel('win-rocm-x64')).toBe('ROCm (~1 GB)')
      expect(friendlyBackendLabel('win-vulkan-x64')).toBe('Vulkan')
    })
  })

  describe('requiredDiskSpaceForBackend', () => {
    it('demands room for the archive plus the ~1 GB unpacked HIP tree', () => {
      // The real b10809 `win-rocm-10.0-x64` archive.
      const archive = 232.9 * 1024 * 1024
      const required = requiredDiskSpaceForBackend('win-rocm-10.0-x64', archive)

      expect(required).not.toBeNull()
      expect(required!).toBeGreaterThan(archive + 1072 * 1024 * 1024)
      // Still under 1.6 GB, so the check does not turn into a de-facto ban.
      expect(required!).toBeLessThan(1.6 * 1024 ** 3)
    })

    it('falls back to a measured archive size for an unmirrored tag', () => {
      expect(requiredDiskSpaceForBackend('win-rocm-10.0-x64')).toBe(
        requiredDiskSpaceForBackend('win-rocm-10.0-x64', 250 * 1024 * 1024)
      )
    })

    it('imposes no precondition on the backends that unpack small', () => {
      expect(requiredDiskSpaceForBackend('win-cuda-13.3-x64', 1)).toBeNull()
      expect(requiredDiskSpaceForBackend('win-vulkan-x64', 1)).toBeNull()
      expect(requiredDiskSpaceForBackend('macos-arm64', 1)).toBeNull()
    })
  })

  describe('getBackendDir and getBackendExePath', () => {
    it('should use the specific backend name for directory path', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('linux-avx2-x64', 'v1.2.3')
      expect(dir).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v1.2.3/linux-avx2-x64`
      )

      const exePath = await getBackendExePath('linux-avx2-x64', 'v1.2.3')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v1.2.3/linux-avx2-x64/build/bin/llama-server`
      )
    })

    it('should use the new common backend name for directory path if it was the asset name', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path.includes('build')
      ) // Mock build dir check

      const dir = await getBackendDir('win-common_cpus-x64', 'v2.0.0')
      expect(dir).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v2.0.0/win-common_cpus-x64`
      )

      const exePath = await getBackendExePath('win-common_cpus-x64', 'v2.0.0')
      expect(exePath).toBe(
        `/path/to/jan/llamacpp-upstream/backends/v2.0.0/win-common_cpus-x64/build/bin/llama-server`
      )
    })
  })

  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `/path/to/jan/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `/path/to/jan/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })
  describe('isBackendInstalled', () => {
    it('should return true when backend is installed using its specific name', async () => {
      vi.stubGlobal('IS_WINDOWS', false) // Linux/macOS for llama-server
      // Mock both the check for the 'build' directory and the final executable path
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        const expectedExePath = `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
        if (path === expectedExePath) return true
        if (path.endsWith('/build')) return true
        return false
      })

      const result = await isBackendInstalled('win-avx2-x64', 'v1.0.0')
      expect(result).toBe(true)
      // Check that it was called with the final exe path
      expect(fs.existsSync).toHaveBeenCalledWith(
        `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/v1.0.0/win-avx2-x64/build/bin/llama-server`
      )
    })
  })
})

describe('backend catalog from the core', () => {
  const catalogOf = (over: Partial<CoreBackendCatalog> = {}): CoreBackendCatalog => ({
    provider: 'llamacpp-upstream',
    os_type: 'windows',
    arch_suffix: 'x64',
    hardware_source: 'probe',
    features: {},
    supported_backends: [],
    remote: [
      { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
      { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
    ],
    installed: [{ version: 'b10100', backend: 'win-cpu-x64', order: 0 }],
    available: [
      { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
      { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
      { version: 'b10100', backend: 'win-cpu-x64', order: 0 },
    ],
    recommended: 'b10205/win-cuda-13.3-x64',
    recommended_installed: 'b10100/win-cpu-x64',
    latest_by_type: {
      'win-cpu-x64': 'b10205/win-cpu-x64',
      'win-cuda-13.3-x64': 'b10205/win-cuda-13.3-x64',
    },
    static_variants: ['win-cpu-x64', 'win-cuda-13-x64'],
    source: 'manifest',
    ...over,
  })

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getBackendCatalog).mockResolvedValue(catalogOf())
  })

  it('reads the manifest half and the hardware-gated half of the one answer', async () => {
    // A fresh read: the memo may hold a previous test's catalog.
    const catalog = await loadCatalog({ force: true })

    await expect(fetchRemoteBackends()).resolves.toEqual(catalog.remote)
    await expect(listSupportedBackends()).resolves.toEqual(catalog.available)
    // Three reads, one round trip.
    expect(getBackendCatalog).toHaveBeenCalledTimes(1)
  })

  it('asks the core once per session and again only when forced', async () => {
    await loadCatalog({ force: true, appVersion: '2.0.0' })
    await loadCatalog()
    await fetchRemoteBackends()
    expect(getBackendCatalog).toHaveBeenCalledTimes(1)
    expect(getBackendCatalog).toHaveBeenCalledWith({
      force: true,
      app_version: '2.0.0',
      proxy: null,
    })

    const newer = catalogOf({
      remote: [{ version: 'b10344', backend: 'win-cpu-x64', order: 0 }],
    })
    vi.mocked(getBackendCatalog).mockResolvedValue(newer)

    // The "check for engine updates" path: a release published while the app
    // was open is invisible to the session copy, which is what `force` defeats.
    await expect(fetchRemoteBackends({ force: true })).resolves.toEqual(
      newer.remote
    )
    expect(getBackendCatalog).toHaveBeenCalledTimes(2)
    expect(getBackendCatalog).toHaveBeenLastCalledWith({
      force: true,
      app_version: null,
      proxy: null,
    })
    expect(catalogSnapshot()).toEqual(newer)
  })

  it('asks the core again on refresh without forcing a refetch of the release stream', async () => {
    // A backend installed from a file never passes through the core; only a new answer sees it,
    // and `configureBackends` decides from what is installed.
    await loadCatalog({ force: true })
    const withNewPack = catalogOf({
      installed: [{ version: 'b99999', backend: 'win-cpu-x64', order: 1 }],
    })
    vi.mocked(getBackendCatalog).mockResolvedValue(withNewPack)
    await expect(loadCatalog({ refresh: true })).resolves.toEqual(withNewPack)
    expect(getBackendCatalog).toHaveBeenCalledTimes(2)
    expect(getBackendCatalog).toHaveBeenLastCalledWith(
      expect.objectContaining({ force: false })
    )
    await loadCatalog()
    expect(getBackendCatalog).toHaveBeenCalledTimes(2)
  })

  it('keeps the last good answer when a forced read fails', async () => {
    const good = await loadCatalog({ force: true })
    vi.mocked(getBackendCatalog).mockRejectedValue(new Error('core unreachable'))

    await expect(loadCatalog({ force: true })).rejects.toThrow('core unreachable')

    expect(catalogSnapshot()).toEqual(good)
    // And the memo still serves it without another round trip.
    await expect(listSupportedBackends()).resolves.toEqual(good.available)
  })

  it('ships a baseline generated from the committed manifest fixture', () => {
    expect(BUNDLED_MANIFEST_BASELINE.tag_name).toBe(
      UPSTREAM_MANIFEST_FIXTURE.tag_name
    )
    expect(BUNDLED_MANIFEST_BASELINE.assets).toEqual(
      UPSTREAM_MANIFEST_FIXTURE.assets
    )
    expect(BUNDLED_MANIFEST_BASELINE.download_base).toBe(
      (UPSTREAM_MANIFEST_FIXTURE as { download_base?: string }).download_base
    )
    expect(BUNDLED_BASELINE_TAG).toBe(UPSTREAM_MANIFEST_FIXTURE.tag_name)
  })
})

describe('parseVersionBackendSetting', () => {
  // The plugin's `handle_setting_update`, ported: same inputs, same answers.
  const identity = async (backend: string) => backend
  const legacy = async (backend: string) =>
    backend === 'win-cuda-cu12.0-x64' ? 'win-cuda-12.4-x64' : backend

  it.each([
    [
      'a first pick with nothing stored',
      'b10205/win-cuda-13.3-x64',
      undefined,
      identity,
      { backend_type_updated: true, effective_backend_type: 'win-cuda-13.3-x64', version: 'b10205', backend: 'win-cuda-13.3-x64' },
    ],
    [
      'the same type as stored',
      'b10344/win-cuda-13.3-x64',
      'win-cuda-13.3-x64',
      identity,
      { backend_type_updated: false, effective_backend_type: 'win-cuda-13.3-x64', version: 'b10344', backend: 'win-cuda-13.3-x64' },
    ],
    [
      'a different type than stored',
      'b10344/win-vulkan-x64',
      'win-cuda-13.3-x64',
      identity,
      { backend_type_updated: true, effective_backend_type: 'win-vulkan-x64', version: 'b10344', backend: 'win-vulkan-x64' },
    ],
    [
      'a BOM and padding left by a PowerShell-generated file',
      '﻿ b10205 / macos-arm64 ',
      undefined,
      identity,
      { backend_type_updated: true, effective_backend_type: 'macos-arm64', version: 'b10205', backend: 'macos-arm64' },
    ],
    [
      'a legacy id, reported as its migrated type while the raw id stays for the install',
      'b10205/win-cuda-cu12.0-x64',
      'win-cuda-cu12.0-x64',
      legacy,
      { backend_type_updated: true, effective_backend_type: 'win-cuda-12.4-x64', version: 'b10205', backend: 'win-cuda-cu12.0-x64' },
    ],
  ])('parses %s', async (_name, value, stored, mapBackend, expected) => {
    await expect(
      parseVersionBackendSetting(value, stored, mapBackend)
    ).resolves.toEqual({ ...expected, needs_backend_installation: true })
  })

  it.each([['b10205'], ['a/b/c'], ['/win-cpu-x64'], ['b10205/'], [''], ['﻿']])(
    'rejects %j as the Rust command did',
    async (value) => {
      await expect(
        parseVersionBackendSetting(value, undefined, identity)
      ).rejects.toThrow('Invalid backend format')
    }
  )
})

describe('cleanupIncompleteBackends', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getJanDataFolderPath).mockResolvedValue(MOCK_JAN_PATH_STRING)
  })

  it('removes a pack without llama-server but leaves an install the core is staging', async () => {
    const root = `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends`
    vi.mocked(fs.readdirSync).mockImplementation(async (path: string) =>
      path === root
        ? ['b10205']
        : path === `${root}/b10205`
          ? ['macos-arm64', 'macos-arm64.incoming-1700000000000']
          : []
    )
    // Only the backends root exists; neither pack has an executable yet.
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => path === root)

    const removed = await cleanupIncompleteBackends()

    expect(removed).toEqual(['b10205/macos-arm64'])
    expect(fs.rm).toHaveBeenCalledTimes(1)
    expect(fs.rm).toHaveBeenCalledWith(`${root}/b10205/macos-arm64`)
  })
})

describe('installed engine packs', () => {
  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(getJanDataFolderPath).mockResolvedValue(MOCK_JAN_PATH_STRING)
    vi.mocked(getLocalInstalledBackendsInternal).mockResolvedValue([
      { version: 'b10205', backend: 'win-cpu-x64' },
      { version: 'b10344', backend: 'win-cpu-x64' },
    ])
    vi.mocked(fs.existsSync).mockResolvedValue(true)
    vi.mocked(fs.readdirSync).mockResolvedValue([])
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('resolves each pack path and marks the selected build', async () => {
    const packs = await listInstalledBackendPacks(
      'llamacpp-upstream',
      'b10344/win-cpu-x64'
    )

    expect(packs).toEqual([
      {
        version: 'b10205',
        backend: 'win-cpu-x64',
        path: `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/b10205/win-cpu-x64`,
        active: false,
      },
      {
        version: 'b10344',
        backend: 'win-cpu-x64',
        path: `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/b10344/win-cpu-x64`,
        active: true,
      },
    ])
  })

  it('removes the build directory and the version dir it emptied', async () => {
    await deleteBackendPack(
      'llamacpp-upstream',
      'b10344/win-cpu-x64',
      'b10205',
      'win-cpu-x64'
    )

    expect(vi.mocked(fs.rm).mock.calls.map(([path]) => path)).toEqual([
      `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/b10205/win-cpu-x64`,
      `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/b10205`,
    ])
  })

  it('keeps a version dir that still holds another build', async () => {
    vi.mocked(fs.readdirSync).mockResolvedValue(['win-vulkan-x64'])

    await deleteBackendPack(
      'llamacpp-upstream',
      'b10344/win-cpu-x64',
      'b10205',
      'win-cpu-x64'
    )

    expect(vi.mocked(fs.rm).mock.calls.map(([path]) => path)).toEqual([
      `${MOCK_JAN_PATH_STRING}/llamacpp-upstream/backends/b10205/win-cpu-x64`,
    ])
  })

  // Deleting the selected build would leave `version_backend` pointing at a
  // directory that no longer exists, so the next model load would fail with a
  // missing-binary error instead of anything the user can act on.
  it('refuses to remove the build currently in use', async () => {
    await expect(
      deleteBackendPack(
        'llamacpp-upstream',
        'b10344/win-cpu-x64',
        'b10344',
        'win-cpu-x64'
      )
    ).rejects.toThrow(/currently selected/)
    expect(vi.mocked(fs.rm).mock.calls).toHaveLength(0)
  })

  it('rejects a pack id carrying a path separator', async () => {
    await expect(
      deleteBackendPack(
        'llamacpp-upstream',
        'b10344/win-cpu-x64',
        '../../models',
        'win-cpu-x64'
      )
    ).rejects.toThrow(/Invalid backend pack/)
    expect(vi.mocked(fs.rm).mock.calls).toHaveLength(0)
  })
})

describe('mergeBackendOptions', () => {
  const latest = [{ value: 'latest/win-cpu-x64', name: 'Latest (CPU)' }]
  const catalog = [
    { value: 'b10344/win-cpu-x64', name: 'b10344/win-cpu-x64' },
    { value: 'b10205/win-cpu-x64', name: 'b10205/win-cpu-x64' },
  ]

  it('keeps every tier so a downloadable release is selectable next to the installed one', () => {
    const installed = [
      { value: 'b10205/win-cpu-x64', name: 'b10205/win-cpu-x64' },
    ]

    expect(
      mergeBackendOptions([latest, catalog, installed]).map((o) => o.value)
    ).toEqual([
      'latest/win-cpu-x64',
      'b10344/win-cpu-x64',
      'b10205/win-cpu-x64',
    ])
  })

  // A build that dropped out of the manifest still runs, so hiding it would
  // mean the dropdown lists fewer versions than the packs dialog does.
  it('keeps a side-loaded build that the catalog no longer offers', () => {
    const installed = [
      { value: 'b9222/win-cpu-x64', name: 'b9222/win-cpu-x64' },
    ]

    expect(
      mergeBackendOptions([catalog, installed]).map((o) => o.value)
    ).toContain('b9222/win-cpu-x64')
  })

  it('prefers the label of the earliest tier for a duplicated build', () => {
    const installed = [
      { value: 'b10344/win-cpu-x64', name: 'raw fallback label' },
    ]

    const merged = mergeBackendOptions([catalog, installed])
    expect(merged.filter((o) => o.value === 'b10344/win-cpu-x64')).toEqual([
      { value: 'b10344/win-cpu-x64', name: 'b10344/win-cpu-x64' },
    ])
  })

  it('forces a recommendation the tiers missed into the list', () => {
    const merged = mergeBackendOptions([catalog], {
      value: 'b10400/win-cuda-13-x64',
      name: 'b10400/win-cuda-13-x64',
    })

    expect(merged[0]).toEqual({
      value: 'b10400/win-cuda-13-x64',
      name: 'b10400/win-cuda-13-x64',
    })
  })

  it('does not duplicate a recommendation the tiers already carry', () => {
    const merged = mergeBackendOptions([catalog], {
      value: 'b10344/win-cpu-x64',
      name: 'duplicate',
    })

    expect(merged.map((o) => o.value)).toEqual([
      'b10344/win-cpu-x64',
      'b10205/win-cpu-x64',
    ])
  })

  it('drops blank ids and the BOM a manifest read can leave behind', () => {
    const merged = mergeBackendOptions([
      [
        { value: '   ', name: 'blank' },
        { value: '\uFEFFb10344/win-cpu-x64', name: 'bom' },
        { value: 'b10344/win-cpu-x64', name: 'clean' },
      ],
    ])

    expect(merged).toEqual([{ value: 'b10344/win-cpu-x64', name: 'bom' }])
  })
})
