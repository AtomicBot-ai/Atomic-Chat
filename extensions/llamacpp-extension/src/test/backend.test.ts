import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  fetchRemoteBackends,
  getBackendDownloadUrl,
  getCudaToolkitVersion,
  getCudartArchiveName,
  getCudartDownloadUrl,
  findUpstreamCudaBinWithCudart,
  upstreamCudaBackendId,
  GGML_ORG_CUDART_PINNED_TAG,
  TURBOQUANT_RELEASE_INDEX_URL,
  TURBOQUANT_LATEST_RELEASE_URL,
  TURBOQUANT_LEGACY_MANIFEST_URL,
  isTurboQuantRelease,
  isStableReleaseTag,
  compareBackendVersions,
  satisfiesMinAppVersion,
  defaultAssetName,
  fetchStableIndex,
  invalidateStableIndexCache,
  listSupportedBackends,
  mergeBackendOptions,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { getVersion } from '@tauri-apps/api/app'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { fs, getJanDataFolderPath } from '@janhq/core'
import {
  determineSupportedBackends,
  getSupportedFeaturesFromRust,
  normalizeFeatures,
  listSupportedBackendsFromRust,
  mapOldBackendToNew,
  getLocalInstalledBackendsInternal,
} from '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'

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
vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
}))
vi.mock('@tauri-apps/plugin-http', () => ({
  fetch: vi.fn(),
}))
vi.mock('../util', () => ({
  getProxyConfig: vi.fn(() => undefined),
}))
vi.mock(
  '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index')
    >('../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index')
    return {
      ...actual,
      determineSupportedBackends: vi.fn(),
      getSupportedFeaturesFromRust: vi.fn(),
      normalizeFeatures: vi.fn((features) => features),
      listSupportedBackendsFromRust: vi.fn(),
      mapOldBackendToNew: vi.fn(),
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

  describe('getBackendDownloadUrl (TurboQuant manifest)', () => {
    afterEach(() => {
      vi.stubGlobal('IS_WINDOWS', false)
    })

    it('resolves to the AtomicBot-ai releases CDN, never api.github.com', () => {
      vi.stubGlobal('IS_WINDOWS', true)
      const url = getBackendDownloadUrl('b10018-1.3.0', 'windows-x64-cuda-12.4')
      expect(url).not.toContain('api.github.com')
      expect(url).toContain(
        'github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download'
      )
    })

    it('resolves the backend index through releases/latest, never a pinned tag', () => {
      expect(TURBOQUANT_RELEASE_INDEX_URL).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest/download/index.json'
      )
      expect(TURBOQUANT_LATEST_RELEASE_URL).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/latest'
      )
      for (const url of [
        TURBOQUANT_RELEASE_INDEX_URL,
        TURBOQUANT_LATEST_RELEASE_URL,
        TURBOQUANT_LEGACY_MANIFEST_URL,
      ]) {
        expect(url).not.toMatch(/b\d+-\d+\.\d+\.\d+/)
        expect(url).not.toMatch(/\/[0-9a-f]{40}\//)
      }
      // The legacy fallback tracks the branch, so a conf update reaches users
      // without an app release too.
      expect(TURBOQUANT_LEGACY_MANIFEST_URL).toContain(
        '/atomic-chat-conf/main/'
      )
    })

    it('prefers the asset name from the index over the naming convention', () => {
      vi.stubGlobal('IS_WINDOWS', true)
      expect(
        getBackendDownloadUrl(
          'b10018-1.3.0',
          'windows-x64-cpu',
          'llama-turboquant-windows-x64-cpu-split.zip'
        )
      ).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10018-1.3.0/llama-turboquant-windows-x64-cpu-split.zip'
      )
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

    it('uses the unified manifest tag verbatim + .zip on Windows', () => {
      vi.stubGlobal('IS_WINDOWS', true)
      const url = getBackendDownloadUrl('b10018-1.3.0', 'windows-x64-cpu')
      expect(url).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10018-1.3.0/llama-turboquant-windows-x64-cpu.zip'
      )
    })

    it('uses .tar.gz on Linux with the unified tag', () => {
      vi.stubGlobal('IS_WINDOWS', false)
      const url = getBackendDownloadUrl('b10018-1.3.0', 'linux-x64-rocm')
      expect(url).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/b10018-1.3.0/llama-turboquant-linux-x64-rocm.tar.gz'
      )
    })

    it('still resolves installs pinned to a legacy per-backend tag', () => {
      vi.stubGlobal('IS_WINDOWS', false)
      const url = getBackendDownloadUrl(
        'turboquant-linux-x64-vulkan-d86eb0b',
        'linux-x64-vulkan'
      )
      expect(url).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/turboquant-linux-x64-vulkan-d86eb0b/llama-turboquant-linux-x64-vulkan.tar.gz'
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

describe('TurboQuant cudart helpers', () => {
  it('maps clean Windows CUDA ids to toolkit minors and archive names', () => {
    expect(getCudaToolkitVersion('windows-x64-cuda-13.3')).toBe('13.3')
    expect(getCudaToolkitVersion('windows-x64-cuda-12.4')).toBe('12.4')
    expect(getCudaToolkitVersion('windows-x64-cpu')).toBeNull()
    expect(getCudaToolkitVersion('linux-x64-vulkan')).toBeNull()
    expect(getCudartArchiveName('windows-x64-cuda-13.3')).toBe(
      'cudart-llama-bin-win-cuda-13.3-x64.zip'
    )
    expect(upstreamCudaBackendId('13.3')).toBe('win-cuda-13.3-x64')
  })

  it('builds ggml-org companion URLs from the pinned upstream tag', () => {
    expect(getCudartDownloadUrl('windows-x64-cuda-13.3')).toBe(
      `https://github.com/ggml-org/llama.cpp/releases/download/${GGML_ORG_CUDART_PINNED_TAG}/cudart-llama-bin-win-cuda-13.3-x64.zip`
    )
    expect(getCudartDownloadUrl('windows-x64-cpu')).toBeNull()
  })

  it('finds an upstream CUDA bin that already has cudart', async () => {
    const jan = '/path/to/jan'
    const donorBin =
      '/path/to/jan/llamacpp-upstream/backends/b10205/win-cuda-13.3-x64/build/bin'
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
      if (path === `${jan}/llamacpp-upstream/backends`) return true
      if (path === `${donorBin}/cudart64_13.dll`) return true
      return false
    })
    vi.mocked(fs.readdirSync).mockResolvedValue([
      '/path/to/jan/llamacpp-upstream/backends/b9691',
      '/path/to/jan/llamacpp-upstream/backends/b10205',
    ] as any)

    await expect(findUpstreamCudaBinWithCudart(jan, '13.3')).resolves.toBe(
      donorBin
    )
  })

  it('knows the CUDA 11 cudart soname', async () => {
    const jan = '/path/to/jan'
    const donorBin =
      '/path/to/jan/llamacpp-upstream/backends/b10205/win-cuda-11.7-x64/build/bin'
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
      if (path === `${jan}/llamacpp-upstream/backends`) return true
      return path === `${donorBin}/cudart64_110.dll`
    })
    vi.mocked(fs.readdirSync).mockResolvedValue([
      '/path/to/jan/llamacpp-upstream/backends/b10205',
    ] as any)

    await expect(findUpstreamCudaBinWithCudart(jan, '11.7')).resolves.toBe(
      donorBin
    )
  })

  it('refuses to guess a soname for an unknown CUDA major', async () => {
    await expect(
      findUpstreamCudaBinWithCudart('/path/to/jan', '10.2')
    ).resolves.toBeNull()
  })

  it('returns null when no upstream install has been made yet', async () => {
    vi.mocked(fs.existsSync).mockResolvedValue(false)

    await expect(
      findUpstreamCudaBinWithCudart('/path/to/jan', '13.3')
    ).resolves.toBeNull()
  })

  it('returns null when every upstream CUDA install lacks cudart', async () => {
    const jan = '/path/to/jan'
    vi.mocked(fs.existsSync).mockImplementation(
      async (path: string) => path === `${jan}/llamacpp-upstream/backends`
    )
    vi.mocked(fs.readdirSync).mockResolvedValue([
      '/path/to/jan/llamacpp-upstream/backends/b10205',
    ] as any)

    await expect(findUpstreamCudaBinWithCudart(jan, '13.3')).resolves.toBeNull()
  })
})

describe('stable release tags', () => {
  it('accepts only the unified release scheme', () => {
    expect(isStableReleaseTag('b10269-1.4.0')).toBe(true)
    expect(isStableReleaseTag('b10269-1.4.0/linux-x64-rocm')).toBe(true)
    expect(isStableReleaseTag('\uFEFF b10269-1.4.0 ')).toBe(true)
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

describe('fetchStableIndex / fetchRemoteBackends', () => {
  const LATEST = 'b10269-1.4.0'
  const PREVIOUS = 'b10018-1.3.0'

  const variants = (ids: string[]) =>
    ids.map((id) => ({
      id,
      asset: `llama-turboquant-${id}.${id.startsWith('windows-') ? 'zip' : 'tar.gz'}`,
    }))

  const releaseIndex = {
    schema_version: 1,
    latest: LATEST,
    releases: [
      {
        tag: LATEST,
        prerelease: false,
        title: `TurboQuant ${LATEST}`,
        highlights: ['DeepSeek V4 Flash support'],
        variants: variants([
          'windows-x64-cpu',
          'windows-x64-cuda-13.3',
          'linux-x64-cpu',
          'linux-x64-cuda-12.4',
          'linux-x64-cuda-13.3',
          'linux-x64-rocm',
          'linux-x64-vulkan',
          'macos-arm64',
        ]),
      },
      {
        tag: PREVIOUS,
        prerelease: false,
        variants: variants(['linux-x64-vulkan', 'macos-arm64']),
      },
      {
        tag: 'dev-latest',
        prerelease: true,
        variants: variants(['linux-x64-vulkan', 'macos-arm64']),
      },
      {
        tag: 'turboquant-linux-x64-vulkan-d86eb0b',
        prerelease: true,
        variants: variants(['linux-x64-vulkan']),
      },
    ],
  }

  const legacyManifest = {
    commit: '5bc5c248d',
    backends: [
      {
        id: 'linux-x64-vulkan',
        tag: PREVIOUS,
        asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
      },
      {
        id: 'macos-arm64',
        tag: PREVIOUS,
        asset: 'llama-turboquant-macos-arm64.tar.gz',
      },
    ],
  }

  const jsonResponse = (body: unknown, url = '') =>
    ({ ok: true, status: 200, url, json: async () => body }) as Response
  const notFound = (url = '') =>
    ({ ok: false, status: 404, url, json: async () => ({}) }) as Response

  /**
   * All three transports (`globalThis.fetch` + two plugin-http variants) race
   * for every URL, so route by URL rather than by call order.
   */
  const route = (
    handlers: Record<string, () => Response | Promise<Response>>
  ) => {
    const impl = async (url: string) => {
      const handler = handlers[url]
      if (!handler) throw new Error(`unrouted ${url}`)
      return handler()
    }
    vi.mocked(globalThis.fetch).mockImplementation(impl as any)
    vi.mocked(tauriFetch).mockImplementation(impl as any)
  }

  const linuxHost = (supported: string[]) => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue(supported)
  }

  beforeEach(() => {
    vi.clearAllMocks()
    invalidateStableIndexCache()
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(getVersion).mockResolvedValue('1.0.0')
    vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
    vi.mocked(fs.existsSync).mockResolvedValue(false)
    vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({} as any)
    vi.mocked(normalizeFeatures).mockImplementation(
      (features) => features as any
    )
    route({ [TURBOQUANT_RELEASE_INDEX_URL]: () => jsonResponse(releaseIndex) })
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.stubGlobal('IS_WINDOWS', false)
    invalidateStableIndexCache()
  })

  it('returns only index variants supported by Windows hardware', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'windows',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue([
      'windows-x64-cpu',
      'windows-x64-cuda-13.3',
    ])

    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: LATEST, backend: 'windows-x64-cpu', order: 0 },
      { version: LATEST, backend: 'windows-x64-cuda-13.3', order: 0 },
    ])
  })

  it('offers the whole Linux GPU matrix the hardware probe reports', async () => {
    linuxHost([
      'linux-x64-cpu',
      'linux-x64-cuda-12.4',
      'linux-x64-cuda-13.3',
      'linux-x64-rocm',
      'linux-x64-vulkan',
    ])

    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: LATEST, backend: 'linux-x64-cpu', order: 0 },
      { version: LATEST, backend: 'linux-x64-cuda-12.4', order: 0 },
      { version: LATEST, backend: 'linux-x64-cuda-13.3', order: 0 },
      { version: LATEST, backend: 'linux-x64-rocm', order: 0 },
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])
  })

  it('drops a hardware-supported backend the releases do not publish', async () => {
    linuxHost(['linux-x64-cuda-11.7', 'linux-x64-vulkan'])

    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])
  })

  it('never offers a prerelease, neither dev-latest nor a legacy variant tag', async () => {
    linuxHost(['linux-x64-vulkan'])

    const catalog = await fetchStableIndex()
    expect(catalog.releases.map((r) => r.tag)).toEqual([LATEST, PREVIOUS])
    const offered = await fetchRemoteBackends()
    expect(offered.map((b) => b.version)).not.toContain('dev-latest')
    expect(offered.map((b) => b.version)).not.toContain(
      'turboquant-linux-x64-vulkan-d86eb0b'
    )
  })

  it('hides a release that demands a newer app and keeps the rest', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () =>
        jsonResponse({
          ...releaseIndex,
          releases: [
            { ...releaseIndex.releases[0], min_app_version: '99.0.0' },
            { ...releaseIndex.releases[1], min_app_version: '0.9.0' },
          ],
        }),
    })

    const catalog = await fetchStableIndex()
    expect(catalog.releases.map((r) => r.tag)).toEqual([PREVIOUS])
    expect(catalog.latest).toBe(PREVIOUS)
  })

  it('surfaces release notes for the dropdown', async () => {
    linuxHost(['linux-x64-vulkan'])

    const catalog = await fetchStableIndex()
    expect(catalog.source).toBe('index')
    expect(catalog.releases[0]).toMatchObject({
      tag: LATEST,
      title: `TurboQuant ${LATEST}`,
      highlights: ['DeepSeek V4 Flash support'],
    })
  })

  it('falls back to the /releases/latest redirect when index.json is absent', async () => {
    linuxHost(['linux-x64-vulkan', 'linux-x64-rocm'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () => notFound(),
      [TURBOQUANT_LATEST_RELEASE_URL]: () =>
        jsonResponse(
          {},
          `https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/${LATEST}`
        ),
    })

    const catalog = await fetchStableIndex()
    expect(catalog.source).toBe('redirect')
    expect(catalog.latest).toBe(LATEST)
    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
      { version: LATEST, backend: 'linux-x64-rocm', order: 0 },
    ])
  })

  it('refuses a redirect that lands on a prerelease', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () => notFound(),
      [TURBOQUANT_LATEST_RELEASE_URL]: () =>
        jsonResponse(
          {},
          'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/tag/dev-latest'
        ),
      [TURBOQUANT_LEGACY_MANIFEST_URL]: () => jsonResponse(legacyManifest),
    })

    const catalog = await fetchStableIndex()
    expect(catalog.source).toBe('legacy-manifest')
    expect(catalog.latest).toBe(PREVIOUS)
  })

  it('falls back to the legacy conf manifest as the last network step', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () => notFound(),
      [TURBOQUANT_LATEST_RELEASE_URL]: () => {
        throw new Error('offline')
      },
      [TURBOQUANT_LEGACY_MANIFEST_URL]: () => jsonResponse(legacyManifest),
    })

    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])
  })

  it('serves the last known good index from disk when every source is down', async () => {
    linuxHost(['linux-x64-vulkan'])
    const cachePath = '/path/to/jan/llamacpp/release-index.cache.json'
    vi.mocked(fs.existsSync).mockImplementation(
      async (path: string) => path === cachePath
    )
    vi.mocked(fs.readFileSync).mockResolvedValue(
      JSON.stringify({
        fetched_at: Date.now(),
        catalog: {
          latest: PREVIOUS,
          source: 'index',
          releases: [
            {
              tag: PREVIOUS,
              prerelease: false,
              variants: variants(['linux-x64-vulkan']),
            },
          ],
        },
      })
    )
    route({})

    const catalog = await fetchStableIndex()
    expect(catalog.source).toBe('disk-cache')
    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: PREVIOUS, backend: 'linux-x64-vulkan', order: 0 },
    ])
  })

  it('degrades to local-only when nothing is reachable and no cache exists', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({})

    await expect(fetchRemoteBackends()).resolves.toEqual([])
  })

  // The next stage splits archives into ~30 MB parts and per-architecture
  // builds. Those fields land in the index before the app understands them.
  it('ignores fields reserved for the split-artifact stage', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () =>
        jsonResponse({
          ...releaseIndex,
          channels: { nightly: 'dev-latest' },
          releases: [
            {
              ...releaseIndex.releases[0],
              signing: { keyid: 'unknown-to-this-client' },
              variants: [
                {
                  id: 'linux-x64-vulkan',
                  asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
                  parts: [{ name: 'part-000', size: 31457280 }],
                  requires: { gfx: ['gfx1100'], driver_min: '560.0' },
                },
              ],
            },
          ],
        }),
    })

    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: LATEST, backend: 'linux-x64-vulkan', order: 0 },
    ])
  })

  // The index is a document from the network: half-written entries must cost
  // the entry, not the whole catalog.
  it('keeps the usable entries of a half-broken index', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () =>
        jsonResponse({
          latest: LATEST,
          releases: [
            { prerelease: false, variants: variants(['linux-x64-vulkan']) },
            { tag: LATEST, prerelease: false, variants: 'not-an-array' },
            { tag: PREVIOUS, prerelease: false, variants: [{ asset: 'x' }] },
            {
              tag: 'b10300-1.5.0',
              prerelease: false,
              published_at: 42,
              commit: null,
              title: ['not', 'a', 'string'],
              highlights: ['kept', 7, null],
              variants: [
                { id: ' linux-x64-vulkan ', asset: 3, size: '10', sha256: 9 },
              ],
            },
          ],
        }),
    })

    const catalog = await fetchStableIndex()
    expect(catalog.releases).toEqual([
      {
        tag: 'b10300-1.5.0',
        published_at: undefined,
        commit: undefined,
        prerelease: false,
        min_app_version: undefined,
        title: undefined,
        highlights: ['kept'],
        variants: [
          {
            id: 'linux-x64-vulkan',
            asset: undefined,
            size: undefined,
            sha256: undefined,
          },
        ],
      },
    ])
  })

  it('refuses an index written to a schema it cannot read', async () => {
    linuxHost(['linux-x64-vulkan'])
    route({
      [TURBOQUANT_RELEASE_INDEX_URL]: () =>
        jsonResponse({ ...releaseIndex, schema_version: 99 }),
      [TURBOQUANT_LATEST_RELEASE_URL]: () => {
        throw new Error('offline')
      },
      [TURBOQUANT_LEGACY_MANIFEST_URL]: () => jsonResponse(legacyManifest),
    })

    const catalog = await fetchStableIndex()
    expect(catalog.source).toBe('legacy-manifest')
  })

  // A cached index is what keeps startup off the network, but it must not
  // hide a release the user is explicitly checking for.
  it('reuses the cached index until an explicit check invalidates it', async () => {
    linuxHost(['linux-x64-vulkan'])

    await fetchStableIndex()
    await fetchStableIndex()
    const callsAfterCacheHit = vi.mocked(globalThis.fetch).mock.calls.length

    invalidateStableIndexCache()
    await fetchStableIndex()

    expect(vi.mocked(globalThis.fetch).mock.calls.length).toBeGreaterThan(
      callsAfterCacheHit
    )
  })

  it('resolves macOS through the same release stream, not the bundle alone', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'macos',
      cpu: { arch: 'arm64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue(['macos-arm64'])

    await expect(fetchRemoteBackends()).resolves.toEqual([
      { version: LATEST, backend: 'macos-arm64', order: 0 },
      { version: PREVIOUS, backend: 'macos-arm64', order: 0 },
    ])
  })
})

describe('listSupportedBackends', () => {
  const merged = [
    { version: 'b10018-1.3.0', backend: 'linux-x64-rocm', order: 0 },
    { version: 'b10018-1.3.0', backend: 'linux-x64-vulkan', order: 0 },
    {
      version: 'turboquant-linux-x64-vulkan-d86eb0b',
      backend: 'linux',
      order: 1,
    },
  ]

  beforeEach(() => {
    vi.clearAllMocks()
    invalidateStableIndexCache()
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
    vi.mocked(fs.existsSync).mockResolvedValue(false)
    vi.mocked(fs.readdirSync).mockResolvedValue([] as any)
    vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({} as any)
    vi.mocked(normalizeFeatures).mockImplementation(
      (features) => features as any
    )
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'))
    vi.mocked(tauriFetch).mockRejectedValue(new Error('offline'))
    vi.mocked(getLocalInstalledBackendsInternal).mockResolvedValue([])
    vi.mocked(listSupportedBackendsFromRust).mockResolvedValue(merged as any)
    // Legacy folder ids collapse onto the bundled Vulkan build.
    vi.mocked(mapOldBackendToNew).mockImplementation(async (backend: string) =>
      backend === 'linux' ? 'linux-x64-vulkan' : backend
    )
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
  })

  it('keeps only what this host can actually run', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue([
      'linux-x64-vulkan',
    ])

    await expect(listSupportedBackends()).resolves.toEqual([
      merged[1],
      merged[2],
    ])
  })

  it('offers a ROCm build once the probe reports ROCm', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue([
      'linux-x64-rocm',
      'linux-x64-vulkan',
    ])

    await expect(listSupportedBackends()).resolves.toEqual(merged)
  })

  // macOS goes through the same hardware gate as everyone else now that its
  // engine updates at runtime; the gate is just a one-entry set there.
  it('gates macOS on the single macos-arm64 id', async () => {
    const macMerged = [
      { version: 'b10269-1.4.0', backend: 'macos-arm64', order: 0 },
      { version: 'b10018-1.3.0', backend: 'linux-x64-vulkan', order: 1 },
    ]
    vi.mocked(listSupportedBackendsFromRust).mockResolvedValue(macMerged as any)
    vi.mocked(mapOldBackendToNew).mockImplementation(
      async (backend: string) => backend
    )
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'macos',
      cpu: { arch: 'arm64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue(['macos-arm64'])

    await expect(listSupportedBackends()).resolves.toEqual([macMerged[0]])
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
        { value: '\uFEFFb10269-1.5.1/macos-arm64', name: 'bom' },
        { value: 'b10269-1.5.1/macos-arm64', name: 'clean' },
      ],
    ])

    expect(merged).toEqual([{ value: 'b10269-1.5.1/macos-arm64', name: 'bom' }])
  })
})
