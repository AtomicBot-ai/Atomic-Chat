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
  TURBOQUANT_BACKEND_MANIFEST_REVISION,
  TURBOQUANT_BACKEND_MANIFEST_URL,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { fetch as tauriFetch } from '@tauri-apps/plugin-http'
import { fs, getJanDataFolderPath } from '@janhq/core'
import {
  determineSupportedBackends,
  getSupportedFeaturesFromRust,
  normalizeFeatures,
} from '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'

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
      const url = getBackendDownloadUrl(
        'turboquant-windows-x64-cuda-12.4-d86eb0b',
        'windows-x64-cuda-12.4'
      )
      expect(url).not.toContain('api.github.com')
      expect(url).toContain(
        'github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download'
      )
    })

    it('pins the backend index to an immutable atomic-chat-conf revision', () => {
      expect(TURBOQUANT_BACKEND_MANIFEST_REVISION).toMatch(/^[0-9a-f]{40}$/)
      expect(TURBOQUANT_BACKEND_MANIFEST_URL).toContain(
        `/atomic-chat-conf/${TURBOQUANT_BACKEND_MANIFEST_REVISION}/`
      )
      expect(TURBOQUANT_BACKEND_MANIFEST_URL).not.toContain('/main/')
    })

    it('uses the per-backend manifest tag verbatim + .zip on Windows', () => {
      vi.stubGlobal('IS_WINDOWS', true)
      const url = getBackendDownloadUrl(
        'turboquant-windows-x64-cpu-d86eb0b',
        'windows-x64-cpu'
      )
      expect(url).toBe(
        'https://github.com/AtomicBot-ai/atomic-llama-cpp-turboquant/releases/download/turboquant-windows-x64-cpu-d86eb0b/llama-turboquant-windows-x64-cpu.zip'
      )
    })

    it('uses .tar.gz on Linux with the per-backend tag', () => {
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
      '/path/to/jan/llamacpp-upstream/backends/b9937/win-cuda-13.3-x64/build/bin'
    vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
      if (path === `${jan}/llamacpp-upstream/backends`) return true
      if (path === `${donorBin}/cudart64_13.dll`) return true
      return false
    })
    vi.mocked(fs.readdirSync).mockResolvedValue([
      '/path/to/jan/llamacpp-upstream/backends/b9691',
      '/path/to/jan/llamacpp-upstream/backends/b9937',
    ] as any)

    await expect(
      findUpstreamCudaBinWithCudart(jan, '13.3')
    ).resolves.toBe(donorBin)
  })
})

describe('fetchRemoteBackends (TurboQuant manifest)', () => {
  const manifest = {
    commit: '61ee3eb',
    backends: [
      {
        id: 'windows-x64-cpu',
        tag: 'turboquant-windows-x64-cpu-61ee3eb',
        asset: 'llama-turboquant-windows-x64-cpu.zip',
      },
      {
        id: 'windows-x64-cuda-13.3',
        tag: 'turboquant-windows-x64-cuda-13.3-61ee3eb',
        asset: 'llama-turboquant-windows-x64-cuda-13.3.zip',
      },
      {
        id: 'linux-x64-vulkan',
        tag: 'turboquant-linux-x64-vulkan-61ee3eb',
        asset: 'llama-turboquant-linux-x64-vulkan.tar.gz',
      },
    ],
  }
  const okResponse = {
    ok: true,
    status: 200,
    json: async () => manifest,
  } as Response

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('fetch', vi.fn())
    vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({} as any)
    vi.mocked(normalizeFeatures).mockImplementation(
      (features) => features as any
    )
    vi.mocked(globalThis.fetch).mockResolvedValue(okResponse)
    vi.mocked(tauriFetch).mockResolvedValue(okResponse)
  })

  afterEach(() => {
    vi.restoreAllMocks()
    vi.unstubAllGlobals()
    vi.stubGlobal('IS_WINDOWS', false)
  })

  it('returns only manifest entries supported by Windows hardware', async () => {
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
      {
        version: 'turboquant-windows-x64-cpu-61ee3eb',
        backend: 'windows-x64-cpu',
        order: 0,
      },
      {
        version: 'turboquant-windows-x64-cuda-13.3-61ee3eb',
        backend: 'windows-x64-cuda-13.3',
        order: 0,
      },
    ])
  })

  it('returns local-only fallback when every manifest transport fails', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'linux',
      cpu: { arch: 'x86_64', extensions: [] },
      gpus: [],
    } as any)
    vi.mocked(determineSupportedBackends).mockResolvedValue([
      'linux-x64-vulkan',
    ])
    vi.mocked(globalThis.fetch).mockRejectedValue(new Error('offline'))
    vi.mocked(tauriFetch).mockRejectedValue(new Error('offline'))

    await expect(fetchRemoteBackends()).resolves.toEqual([])
  })

  it('skips manifest transport on macOS', async () => {
    vi.mocked(getSystemInfo).mockResolvedValue({
      os_type: 'macos',
      cpu: { arch: 'arm64', extensions: [] },
      gpus: [],
    } as any)

    await expect(fetchRemoteBackends()).resolves.toEqual([])
    expect(globalThis.fetch).not.toHaveBeenCalled()
    expect(tauriFetch).not.toHaveBeenCalled()
  })
})
