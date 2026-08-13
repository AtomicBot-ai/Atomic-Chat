import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  fetchRemoteBackends,
  getBackendArchiveName,
  getBackendDownloadUrl,
  BUNDLED_BASELINE_TAG,
  resolveGpuFamilyConcrete,
  isConcreteOfGpuFamily,
  friendlyBackendLabel,
  requiredDiskSpaceForBackend,
  listInstalledBackendPacks,
  deleteBackendPack,
  mergeBackendOptions,
} from '../backend'
import { BUNDLED_MANIFEST_BASELINE } from '../bundledManifestBaseline'
import UPSTREAM_MANIFEST_FIXTURE from '../../../../tests/fixtures/registries/upstream-manifest.json'
import { getSystemInfo } from '../hardware'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
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
vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
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

    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: {
        arch: 'x86_64',
        extensions: [],
      },
      gpus: [],
    } as any)

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
    })

    it('labels the ROCm variants with their weight', () => {
      expect(friendlyBackendLabel('win-rocm-7.14-x64')).toBe(
        'ROCm 7.14 (~1 GB)'
      )
      expect(friendlyBackendLabel('win-rocm-x64')).toBe('ROCm (~1 GB)')
      expect(friendlyBackendLabel('win-vulkan-x64')).toBe('Vulkan')
    })
  })

  describe('requiredDiskSpaceForBackend', () => {
    it('demands room for the archive plus the ~980 MB unpacked HIP tree', () => {
      const archive = 196 * 1024 * 1024
      const required = requiredDiskSpaceForBackend('win-rocm-7.14-x64', archive)

      expect(required).not.toBeNull()
      expect(required!).toBeGreaterThan(archive + 980 * 1024 * 1024)
      // Still under 1.5 GB, so the check does not turn into a de-facto ban.
      expect(required!).toBeLessThan(1.5 * 1024 ** 3)
    })

    it('falls back to a measured archive size for an unmirrored tag', () => {
      expect(requiredDiskSpaceForBackend('win-rocm-7.14-x64')).toBe(
        requiredDiskSpaceForBackend('win-rocm-7.14-x64', 200 * 1024 * 1024)
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

describe('fetchRemoteBackends (atomic-chat-conf manifest, ATO-199)', () => {
  // Mirrors the static manifest in atomic-chat-conf/backends/manifest.json:
  // a GitHub release shape ({ tag_name, assets: [{ name }] }).
  const MANIFEST = {
    $schema: './schema.json',
    updated_at: '2026-07-31T13:26:25Z',
    tag_name: 'b10205',
    assets: [
      { name: 'llama-b10205-bin-win-cpu-x64.zip' },
      { name: 'llama-b10205-bin-win-cuda-12.4-x64.zip' },
      { name: 'llama-b10205-bin-win-cuda-13.3-x64.zip' },
      { name: 'llama-b10205-bin-win-vulkan-x64.zip' },
      { name: 'llama-b10205-bin-ubuntu-x64.tar.gz' },
      { name: 'llama-b10205-bin-ubuntu-vulkan-x64.tar.gz' },
      { name: 'llama-b10205-bin-macos-arm64.tar.gz' },
      { name: 'cudart-llama-bin-win-cuda-12.4-x64.zip' },
      { name: 'cudart-llama-bin-win-cuda-13.3-x64.zip' },
    ],
  }

  const RAW_MANIFEST_URL =
    'https://raw.githubusercontent.com/AtomicBot-ai/atomic-chat-conf/main/backends/manifest.json'

  const okResponse = (body: unknown) =>
    ({
      ok: true,
      status: 200,
      headers: { get: () => null },
      json: async () => body,
    }) as unknown as Response

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(tauriFetch).mockResolvedValue(okResponse(MANIFEST))
    vi.stubGlobal(
      'fetch',
      vi.fn().mockRejectedValue(new Error('web fetch unavailable'))
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  it('returns the bundled baseline when every manifest transport fails', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'windows',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(tauriFetch).mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response)
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'))

    // How many Windows variants the baseline carries changes with every synced
    // tag, so assert the tag rather than the count.
    const backends = await fetchRemoteBackends()
    expect(backends.length).toBeGreaterThan(0)
    expect(
      backends.every((backend) => backend.version === BUNDLED_BASELINE_TAG)
    ).toBe(true)
  })

  it('follows a manifest tag newer than the bundled baseline', async () => {
    // Derived from the baseline instead of written out: a literal here would
    // silently stop testing "newer" the moment the baseline caught up to it.
    const newerTag = `b${Number(BUNDLED_BASELINE_TAG.slice(1)) + 1}`
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'windows',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(tauriFetch).mockResolvedValue(
      okResponse({
        ...MANIFEST,
        tag_name: newerTag,
        assets: [{ name: `llama-${newerTag}-bin-win-cpu-x64.zip` }],
      })
    )

    const backends = await fetchRemoteBackends({ force: true })

    expect(new Set(backends.map((backend) => backend.version))).toEqual(
      new Set([newerTag])
    )
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
  })

  it('resolves the manifest from raw atomic-chat-conf, not api.github.com', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'windows',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)

    await fetchRemoteBackends({ force: true })

    expect(tauriFetch).toHaveBeenCalledTimes(2)
    for (const [calledUrl] of vi.mocked(tauriFetch).mock.calls) {
      expect(calledUrl).toBe(RAW_MANIFEST_URL)
      expect(calledUrl).not.toContain('api.github.com')
    }
  })

  it('returns the whitelisted Windows backend catalog', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'windows',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)

    const backends = await fetchRemoteBackends()
    const names = backends.map((b) => b.backend).sort()

    expect(names).toEqual([
      'win-cpu-x64',
      'win-cuda-12.4-x64',
      'win-cuda-13.3-x64',
      'win-vulkan-x64',
    ])
    // cudart companions are not surfaced as backends.
    expect(names).not.toContain('cudart-llama-bin-win-cuda-12.4-x64')
    backends.forEach((b) => expect(b.version).toBe('b10205'))
  })

  it('returns cpu + vulkan for Linux x64', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)

    const backends = await fetchRemoteBackends()
    const names = backends.map((b) => b.backend).sort()

    expect(names).toEqual(['linux-cpu-x64', 'linux-vulkan-x64'])
    backends.forEach((b) => expect(b.version).toBe('b10205'))
  })

  it('returns the arm64 build on an Apple Silicon Mac', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'macos',
      cpu: { arch: 'arm64', extensions: [] },
      gpus: [],
    } as any)

    const backends = await fetchRemoteBackends({ force: true })

    expect(backends).toEqual([
      { version: 'b10205', backend: 'macos-arm64', order: 0 },
    ])
    expect(tauriFetch).toHaveBeenCalled()
  })

  it('offers nothing to an Intel Mac, even if the manifest grows an arm64-only tag', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'macos',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)

    const backends = await fetchRemoteBackends({ force: true })

    // macOS keeps the merged list unfiltered downstream, so an unfiltered
    // parser would hand an Intel host an arm64 build it cannot run. Runtime
    // updates on macOS are Apple Silicon only; Intel stays on its bundle.
    expect(backends).toEqual([])
  })

  it('falls back to the bundled baseline on macOS when every transport fails', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'macos',
      cpu: { arch: 'arm64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(tauriFetch).mockResolvedValue({
      ok: false,
      status: 503,
      headers: { get: () => null },
      json: async () => ({}),
    } as unknown as Response)
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'))

    const backends = await fetchRemoteBackends({ force: true })

    expect(backends).toEqual([
      {
        version: BUNDLED_BASELINE_TAG,
        backend: 'macos-arm64',
        order: 0,
      },
    ])
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
