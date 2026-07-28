import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import {
  getBackendDir,
  getBackendExePath,
  isBackendInstalled,
  getBackendDownloadUrl,
  TURBOQUANT_BACKEND_MANIFEST_REVISION,
  TURBOQUANT_BACKEND_MANIFEST_URL,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { fs, getJanDataFolderPath } from '@janhq/core'

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
      vi.mocked(fs.readdirSync).mockResolvedValue([`${exeDir}/llama-server.exe`])

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
      vi.mocked(fs.readdirSync).mockRejectedValue(new Error('permission denied'))

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
