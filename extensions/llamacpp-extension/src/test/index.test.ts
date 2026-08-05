import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import llamacpp_extension from '../index'

import {
  getSupportedFeaturesFromRust,
  normalizeLlamacppConfig,
} from '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
import { listSupportedBackends } from '../backend'
import { getSystemInfo } from '../hardware'

// Mock fetch globally
global.fetch = vi.fn()

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock backend functions
// Partial mock: the pure predicates (`isStableReleaseTag`,
// `compareBackendVersions`, ...) stay real so the tests exercise the actual
// stable-release rules rather than a second copy of them.
vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return {
    ...actual,
    isBackendInstalled: vi.fn(),
    getBackendExePath: vi.fn(),
    listSupportedBackends: vi.fn(),
    getBackendDir: vi.fn(),
    fetchStableIndex: vi.fn(async () => ({
      latest: null,
      releases: [],
      source: 'none' as const,
    })),
    invalidateStableIndexCache: vi.fn(),
  }
})

// Mock tauri-plugin-llamacpp-api (partial mock)
vi.mock(
  '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index')
    >('../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index')

    return {
      ...actual,
      getSupportedFeaturesFromRust: vi.fn(),
      findLatestVersionForBackend: vi.fn(),
      mapOldBackendToNew: vi.fn(),
      removeOldBackendVersions: vi.fn(),
      readGgufMetadata: vi.fn(),
      unloadLlamaModel: vi.fn(),
    }
  }
)
describe('llamacpp_extension', () => {
  let extension: llamacpp_extension

  beforeEach(() => {
    vi.clearAllMocks()
    extension = new llamacpp_extension()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should initialize with correct default values', () => {
      expect(extension.provider).toBe('llamacpp')
      expect(extension.providerId).toBe('llamacpp')
      expect(extension.autoUnload).toBe(false)
    })
  })

  describe('hardware backend recommendation', () => {
    /// Everything the unified `b10018-1.3.0` release publishes for Linux x64.
    const LINUX_CATALOG = [
      'linux-x64-cpu',
      'linux-x64-cuda-12.4',
      'linux-x64-cuda-13.3',
      'linux-x64-rocm',
      'linux-x64-vulkan',
    ]

    const discreteGpu = {
      name: 'Test GPU',
      total_memory: 12 * 1024,
      vendor: 'NVIDIA',
      uuid: 'fixture-gpu',
      driver_version: 'fixture',
      nvidia_info: {},
      vulkan_info: { device_type: 'DiscreteGpu' },
    }

    it.each([
      {
        name: 'Windows CUDA 13',
        system: {
          os_type: 'windows',
          os_name: 'Windows',
          total_memory: 32 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [discreteGpu],
        },
        features: { cuda12: true, cuda13: true, vulkan: true },
        catalog: [
          'windows-x64-cpu',
          'windows-x64-cuda-12.4',
          'windows-x64-cuda-13.3',
          'windows-x64-vulkan',
        ],
        expected: { kind: 'gpu', backend: 'windows-x64-cuda-13.3' },
      },
      {
        name: 'Linux CUDA 13',
        system: {
          os_type: 'linux',
          os_name: 'Linux',
          total_memory: 32 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [discreteGpu],
        },
        features: { cuda12: true, cuda13: true, vulkan: true },
        catalog: LINUX_CATALOG,
        expected: { kind: 'gpu', backend: 'linux-x64-cuda-13.3' },
      },
      {
        name: 'Linux CUDA 12',
        system: {
          os_type: 'linux',
          os_name: 'Linux',
          total_memory: 32 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [discreteGpu],
        },
        features: { cuda12: true, cuda13: false, vulkan: true },
        catalog: LINUX_CATALOG,
        expected: { kind: 'gpu', backend: 'linux-x64-cuda-12.4' },
      },
      {
        name: 'Linux ROCm',
        system: {
          os_type: 'linux',
          os_name: 'Linux',
          total_memory: 32 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [{ ...discreteGpu, vendor: 'AMD', nvidia_info: undefined }],
        },
        features: { cuda12: false, cuda13: false, rocm: true, vulkan: true },
        catalog: LINUX_CATALOG,
        expected: { kind: 'gpu', backend: 'linux-x64-rocm' },
      },
      {
        // An AMD card whose ROCm probe came back negative (unsupported gfx
        // target, or no HIP runtime installed) still gets a GPU — Vulkan.
        name: 'Linux AMD without a usable ROCm runtime',
        system: {
          os_type: 'linux',
          os_name: 'Linux',
          total_memory: 32 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [{ ...discreteGpu, vendor: 'AMD', nvidia_info: undefined }],
        },
        features: { cuda12: false, cuda13: false, rocm: false, vulkan: true },
        catalog: LINUX_CATALOG,
        expected: { kind: 'gpu', backend: 'linux-x64-vulkan' },
      },
      {
        // The release publishes ROCm, but this host's probe says no and the
        // bundled Vulkan build is all that is installed offline.
        name: 'Linux Vulkan-only catalog',
        system: {
          os_type: 'linux',
          os_name: 'Linux',
          total_memory: 32 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [discreteGpu],
        },
        features: { cuda12: false, cuda13: false, vulkan: true },
        catalog: ['linux-x64-vulkan'],
        expected: { kind: 'gpu', backend: 'linux-x64-vulkan' },
      },
    ])('selects the pinned $name backend', async (profile) => {
      vi.mocked(getSystemInfo).mockResolvedValue(profile.system as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue(
        profile.features as any
      )
      vi.mocked(listSupportedBackends).mockResolvedValue(
        profile.catalog.map((backend) => ({
          version: 'fixture',
          backend,
          order: 0,
        }))
      )

      await expect(extension['detectIdealBackendType']()).resolves.toEqual(
        profile.expected
      )
    })

    it('keeps an integrated-only Vulkan host on CPU', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 16 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [
          {
            ...discreteGpu,
            nvidia_info: undefined,
            vulkan_info: { device_type: 'IntegratedGpu' },
          },
        ],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda12: false,
        cuda13: false,
        vulkan: true,
      } as any)
      vi.mocked(listSupportedBackends).mockResolvedValue([
        {
          version: 'fixture',
          backend: 'linux-x64-vulkan',
          order: 0,
        },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'cpu-optimal',
      })
    })

    it('keeps an integrated-only ROCm-capable APU on CPU', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [
          {
            ...discreteGpu,
            vendor: 'AMD',
            nvidia_info: undefined,
            vulkan_info: { device_type: 'IntegratedGpu' },
          },
        ],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda12: false,
        cuda13: false,
        rocm: true,
        vulkan: true,
      } as any)
      vi.mocked(listSupportedBackends).mockResolvedValue(
        LINUX_CATALOG.map((backend) => ({
          version: 'b10018-1.3.0',
          backend,
          order: 0,
        }))
      )

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'cpu-optimal',
      })
    })

    /// A modern AMD/Intel iGPU reports its share of system RAM as Vulkan
    /// DEVICE_LOCAL memory, so it clears the 6 GiB bar that stands in for "a
    /// real graphics card". Only `device_type` separates it from a discrete GPU,
    /// and Vulkan on such a host is slower than plain CPU inference.
    const integratedGpu = (name: string, vendor: string, vramMiB: number) => ({
      name,
      vendor,
      total_memory: vramMiB,
      uuid: `igpu-${vendor}`,
      driver_version: 'fixture',
      nvidia_info: undefined,
      vulkan_info: { device_type: 'IntegratedGpu' },
    })

    it.each([
      { name: 'AMD Radeon 780M', vendor: 'AMD', vram: 16 * 1024 },
      { name: 'Intel Arc 140V', vendor: 'Intel', vram: 8 * 1024 },
      { name: 'Intel UHD Graphics 770', vendor: 'Intel', vram: 32 * 1024 },
    ])(
      'keeps a Windows host with only a $name on CPU despite its large shared VRAM',
      async (igpu) => {
        vi.mocked(getSystemInfo).mockResolvedValue({
          os_type: 'windows',
          os_name: 'Windows',
          total_memory: 64 * 1024,
          cpu: { arch: 'x86_64', extensions: [] },
          gpus: [integratedGpu(igpu.name, igpu.vendor, igpu.vram)],
        } as any)
        vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
          cuda12: false,
          cuda13: false,
          vulkan: true,
        } as any)
        // The Vulkan asset is present in the catalog, so CPU here is a decision
        // about the hardware, not a missing download.
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'fixture', backend: 'windows-x64-cpu', order: 0 },
          { version: 'fixture', backend: 'windows-x64-vulkan', order: 0 },
        ])

        await expect(extension['detectIdealBackendType']()).resolves.toEqual({
          kind: 'cpu-optimal',
        })
      }
    )

    it('still recommends CUDA on a hybrid laptop with an iGPU beside the dGPU', async () => {
      // The integrated-only guard must not fire just because an iGPU is
      // enumerated first — laptops report both.
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [integratedGpu('Intel Iris Xe', 'Intel', 16 * 1024), discreteGpu],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda12: true,
        cuda13: true,
        vulkan: true,
      } as any)
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'fixture', backend: 'windows-x64-cpu', order: 0 },
        { version: 'fixture', backend: 'windows-x64-cuda-13.3', order: 0 },
        { version: 'fixture', backend: 'windows-x64-vulkan', order: 0 },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'windows-x64-cuda-13.3',
      })
    })

    it('recommends Vulkan for a discrete AMD card with no CUDA tier', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [
          integratedGpu('AMD Radeon 780M', 'AMD', 16 * 1024),
          {
            name: 'AMD Radeon RX 7900 XTX',
            vendor: 'AMD',
            total_memory: 24 * 1024,
            uuid: 'dgpu-amd',
            driver_version: 'fixture',
            nvidia_info: undefined,
            vulkan_info: { device_type: 'DiscreteGpu' },
          },
        ],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda12: false,
        cuda13: false,
        vulkan: true,
      } as any)
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'fixture', backend: 'windows-x64-cpu', order: 0 },
        { version: 'fixture', backend: 'windows-x64-vulkan', order: 0 },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'windows-x64-vulkan',
      })
    })

    it('reports detection failure when a GPU tier has no manifest asset', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [discreteGpu],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda12: true,
        cuda13: true,
        vulkan: false,
      } as any)
      vi.mocked(listSupportedBackends).mockResolvedValue([
        {
          version: 'fixture',
          backend: 'windows-x64-cpu',
          order: 0,
        },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'detection-failed',
      })
    })
  })

  describe('backend preference storage', () => {
    it('uses the TurboQuant-specific key', () => {
      vi.mocked(localStorage.getItem).mockReturnValueOnce('windows-x64-vulkan')

      expect(extension['getStoredBackendType']()).toBe('windows-x64-vulkan')
      expect(localStorage.getItem).toHaveBeenCalledWith(
        'atomic_llamacpp_turboquant_backend_type'
      )
    })

    it('migrates a matching legacy TurboQuant preference', () => {
      vi.mocked(localStorage.getItem)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce('windows-x64-vulkan')

      expect(extension['getStoredBackendType']()).toBe('windows-x64-vulkan')
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'atomic_llamacpp_turboquant_backend_type',
        'windows-x64-vulkan'
      )
    })

    it('does not import an upstream preference from the shared key', () => {
      vi.mocked(localStorage.getItem)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce('win-vulkan-x64')

      expect(extension['getStoredBackendType']()).toBeNull()
      expect(localStorage.setItem).not.toHaveBeenCalled()
    })

    it('writes and clears only the TurboQuant-specific key', () => {
      extension['setStoredBackendType']('windows-x64-vulkan')
      extension['clearStoredBackendType']()

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'atomic_llamacpp_turboquant_backend_type',
        'windows-x64-vulkan'
      )
      expect(localStorage.removeItem).toHaveBeenCalledWith(
        'atomic_llamacpp_turboquant_backend_type'
      )
    })
  })

  describe('getProviderPath', () => {
    it('should return correct provider path', async () => {
      const { getJanDataFolderPath, joinPath } = await import('@janhq/core')

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockResolvedValue('/path/to/jan/llamacpp')

      const result = await extension.getProviderPath()

      expect(result).toBe('/path/to/jan/llamacpp')
    })
  })

  describe('list', () => {
    it('should return empty array when models directory does not exist', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockResolvedValue('/path/to/jan/llamacpp/models')
      vi.mocked(fs.existsSync)
        .mockResolvedValueOnce(false) // models directory doesn't exist initially
        .mockResolvedValue(false) // no model.yml files exist
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(fs.readdirSync).mockResolvedValue([]) // empty directory after creation

      const result = await extension.list()

      expect(result).toEqual([])
    })

    it('should return imported models with their source', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')
      const { invoke } = await import('@tauri-apps/api/core')

      // Set up providerPath first
      extension['providerPath'] = '/path/to/jan/llamacpp'

      const modelsDir = '/path/to/jan/llamacpp/models'

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')

      // Mock joinPath to handle the directory traversal logic
      vi.mocked(joinPath).mockImplementation((paths) => {
        if (paths.length === 1) {
          return Promise.resolve(paths[0])
        }
        return Promise.resolve(paths.join('/'))
      })

      vi.mocked(fs.existsSync)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(false)
        .mockResolvedValueOnce(true)
        .mockResolvedValueOnce(true)
        .mockResolvedValue(true)

      vi.mocked(fs.readdirSync)
        .mockResolvedValueOnce(['test-model'])
        .mockResolvedValue([])
      vi.mocked(fs.fileStat).mockResolvedValue({
        isDirectory: true,
        size: 1000,
      })

      vi.mocked(invoke).mockResolvedValue({
        model_path: 'test-model/model.gguf',
        name: 'Test Model',
        size_bytes: 1000000,
        source: 'lmstudio',
      })
      const { readGgufMetadata } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(readGgufMetadata).mockResolvedValue({
        version: 3,
        tensor_count: 1,
        metadata: { 'general.architecture': 'llama' },
      } as any)

      const result = await extension.list()

      expect(result).toMatchObject([
        {
          id: 'test-model',
          name: 'Test Model',
          providerId: 'llamacpp',
          sizeBytes: 1000000,
          embedding: false,
          source: 'lmstudio',
          missing: false,
        },
      ])
    })
  })

  describe('import', () => {
    it('should throw error for invalid modelId', async () => {
      await expect(
        extension.import('invalid/model/../id', { modelPath: '/path/to/model' })
      ).rejects.toThrow('Invalid modelId')
    })

    it('should throw error if model already exists', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockResolvedValue(
        '/path/to/jan/llamacpp/models/test-model/model.yml'
      )
      vi.mocked(fs.existsSync).mockResolvedValue(true)

      await expect(
        extension.import('test-model', { modelPath: '/path/to/model' })
      ).rejects.toThrow('Model test-model already exists')
    })

    it('should import model from URL', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')
      const { invoke } = await import('@tauri-apps/api/core')

      const mockDownloadManager = {
        downloadFiles: vi.fn().mockResolvedValue(undefined),
      }

      window.core.extensionManager.getByName = vi
        .fn()
        .mockReturnValue(mockDownloadManager)

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      vi.mocked(fs.existsSync).mockResolvedValue(false)
      vi.mocked(fs.fileStat).mockResolvedValue({ size: 1000000 })
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
      vi.mocked(invoke).mockResolvedValue(undefined)
      const { readGgufMetadata } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(readGgufMetadata).mockResolvedValue({
        version: 3,
        tensor_count: 1,
        metadata: { 'general.architecture': 'llama' },
      } as any)

      await extension.import('test-model', {
        modelPath: 'https://example.com/model.gguf',
      })

      expect(mockDownloadManager.downloadFiles).toHaveBeenCalled()
      expect(fs.mkdir).toHaveBeenCalled()
      expect(invoke).toHaveBeenCalledWith('write_yaml', expect.any(Object))
    })
  })

  describe('load', () => {
    it('should throw error if model is already loaded', async () => {
      extension['findSessionByModel'] = vi.fn().mockResolvedValue({
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-key',
      })

      await expect(extension.load('test-model')).rejects.toThrow(
        'Model already loaded!!'
      )
    })

    it('should load model successfully', async () => {
      const session = {
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-api-key',
      }
      extension['findSessionByModel'] = vi.fn().mockResolvedValue(null)
      extension['performLoad'] = vi.fn().mockResolvedValue(session)
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: 'ok' }),
      })

      const result = await extension.load('test-model')

      expect(result).toEqual(session)
      expect(extension['performLoad']).toHaveBeenCalledWith(
        'test-model',
        undefined,
        false,
        false
      )
    })
  })

  describe('unload', () => {
    it('should throw error if no active session found', async () => {
      await expect(extension.unload('nonexistent-model')).rejects.toThrow(
        'No active session found'
      )
    })

    it('should unload model successfully', async () => {
      const { unloadLlamaModel } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )

      extension['sessionCache'].set('test-model', {
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-key',
      })

      vi.mocked(unloadLlamaModel).mockResolvedValue({
        success: true,
        error: null,
      })

      const result = await extension.unload('test-model')

      expect(result).toEqual({
        success: true,
        error: null,
      })

      expect(extension['sessionCache'].has('test-model')).toBe(false)
    })
  })

  describe('chat', () => {
    it('should throw error if no active session found', async () => {
      const request = {
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }

      await expect(extension.chat(request)).rejects.toThrow(
        'No active session found'
      )
    })

    it('should handle non-streaming chat request', async () => {
      const { invoke } = await import('@tauri-apps/api/core')

      extension['sessionCache'].set('test-model', {
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-key',
      })

      vi.mocked(invoke).mockResolvedValue(true) // is_process_running

      const mockResponse = {
        id: 'test-id',
        object: 'chat.completion',
        created: Date.now(),
        model: 'test-model',
        choices: [
          {
            index: 0,
            message: { role: 'assistant', content: 'Hello!' },
            finish_reason: 'stop',
          },
        ],
      }

      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: () => Promise.resolve(mockResponse),
      })

      const request = {
        model: 'test-model',
        messages: [{ role: 'user', content: 'Hello' }],
        stream: false,
      }

      const result = await extension.chat(request)

      expect(result).toEqual(mockResponse)
      expect(fetch).toHaveBeenCalledWith(
        'http://localhost:3000/v1/chat/completions',
        expect.objectContaining({
          method: 'POST',
          headers: {
            'Content-Type': 'application/json',
            'Authorization': 'Bearer test-key',
          },
        })
      )
    })
  })

  describe('delete', () => {
    it('should throw error if model does not exist', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      vi.mocked(fs.existsSync).mockResolvedValue(false)

      await expect(extension.delete('nonexistent-model')).rejects.toThrow(
        'Model nonexistent-model does not exist'
      )
    })

    it('should delete model successfully', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      vi.mocked(fs.existsSync).mockResolvedValue(true)
      vi.mocked(fs.rm).mockResolvedValue(undefined)

      await extension.delete('test-model')

      expect(fs.rm).toHaveBeenCalledWith(
        '/path/to/jan/llamacpp/models/test-model'
      )
    })
  })

  describe('migrateKvCacheDefaults', () => {
    beforeEach(() => {
      vi.mocked(localStorage.getItem).mockReturnValue(null)
    })

    it('should skip migration if already migrated', async () => {
      vi.mocked(localStorage.getItem).mockReturnValue('1')
      extension['config'] = { cache_type_k: 'f16', cache_type_v: 'f16' } as any
      extension['getSettings'] = vi.fn()

      await extension['migrateKvCacheDefaults']()

      expect(extension['getSettings']).not.toHaveBeenCalled()
    })

    it('should set migration key without calling updateSettings when no f16 values', async () => {
      extension['config'] = {
        cache_type_k: 'q8_0',
        cache_type_v: 'q8_0',
      } as any
      extension['getSettings'] = vi.fn()
      extension['updateSettings'] = vi.fn()

      await extension['migrateKvCacheDefaults']()

      expect(extension['getSettings']).not.toHaveBeenCalled()
      expect(extension['updateSettings']).not.toHaveBeenCalled()
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'llamacpp_kv_cache_migrated_v1',
        '1'
      )
    })

    it('should migrate cache_type_k from f16 to q8_0', async () => {
      extension['config'] = { cache_type_k: 'f16', cache_type_v: 'q8_0' } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'cache_type_k', controllerProps: { value: 'f16' } },
        { key: 'cache_type_v', controllerProps: { value: 'q8_0' } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateKvCacheDefaults']()

      const updatedSettings = vi.mocked(extension['updateSettings']).mock
        .calls[0][0]
      expect(
        updatedSettings.find((s: any) => s.key === 'cache_type_k')
          .controllerProps.value
      ).toBe('q8_0')
      expect(
        updatedSettings.find((s: any) => s.key === 'cache_type_v')
          .controllerProps.value
      ).toBe('q8_0')
      expect(extension['config'].cache_type_k).toBe('q8_0')
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'llamacpp_kv_cache_migrated_v1',
        '1'
      )
    })

    it('should migrate cache_type_v from f16 to q8_0', async () => {
      extension['config'] = { cache_type_k: 'q8_0', cache_type_v: 'f16' } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'cache_type_k', controllerProps: { value: 'q8_0' } },
        { key: 'cache_type_v', controllerProps: { value: 'f16' } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateKvCacheDefaults']()

      const updatedSettings = vi.mocked(extension['updateSettings']).mock
        .calls[0][0]
      expect(
        updatedSettings.find((s: any) => s.key === 'cache_type_v')
          .controllerProps.value
      ).toBe('q8_0')
      expect(extension['config'].cache_type_v).toBe('q8_0')
    })

    it('should migrate both cache types when both are f16', async () => {
      extension['config'] = { cache_type_k: 'f16', cache_type_v: 'f16' } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'cache_type_k', controllerProps: { value: 'f16' } },
        { key: 'cache_type_v', controllerProps: { value: 'f16' } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateKvCacheDefaults']()

      expect(extension['config'].cache_type_k).toBe('q8_0')
      expect(extension['config'].cache_type_v).toBe('q8_0')
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'llamacpp_kv_cache_migrated_v1',
        '1'
      )
    })

    it('should not overwrite non-f16 values in settings during migration', async () => {
      extension['config'] = { cache_type_k: 'f16', cache_type_v: 'q4_0' } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'cache_type_k', controllerProps: { value: 'f16' } },
        { key: 'cache_type_v', controllerProps: { value: 'q4_0' } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateKvCacheDefaults']()

      const updatedSettings = vi.mocked(extension['updateSettings']).mock
        .calls[0][0]
      expect(
        updatedSettings.find((s: any) => s.key === 'cache_type_v')
          .controllerProps.value
      ).toBe('q4_0')
    })
  })

  describe('migrateFitDefault', () => {
    beforeEach(() => {
      vi.mocked(localStorage.getItem).mockReturnValue(null)
    })

    it('should skip migration if already migrated', async () => {
      vi.mocked(localStorage.getItem).mockReturnValue('1')
      extension['config'] = { fit: true } as any
      extension['getSettings'] = vi.fn()

      await extension['migrateFitDefault']()

      expect(extension['getSettings']).not.toHaveBeenCalled()
    })

    it('should set migration key without calling updateSettings when fit is already false', async () => {
      extension['config'] = { fit: false } as any
      extension['getSettings'] = vi.fn()
      extension['updateSettings'] = vi.fn()

      await extension['migrateFitDefault']()

      expect(extension['getSettings']).not.toHaveBeenCalled()
      expect(extension['updateSettings']).not.toHaveBeenCalled()
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'llamacpp_fit_disabled_v1',
        '1'
      )
    })

    it('should disable fit when it is true', async () => {
      extension['config'] = { fit: true } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'fit', controllerProps: { value: true } },
        { key: 'ctx_size', controllerProps: { value: 2048 } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateFitDefault']()

      const updatedSettings = vi.mocked(extension['updateSettings']).mock
        .calls[0][0]
      expect(
        updatedSettings.find((s: any) => s.key === 'fit').controllerProps.value
      ).toBe(false)
      expect(
        updatedSettings.find((s: any) => s.key === 'ctx_size').controllerProps
          .value
      ).toBe(2048)
      expect(extension['config'].fit).toBe(false)
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'llamacpp_fit_disabled_v1',
        '1'
      )
    })

    it('should not modify other settings during fit migration', async () => {
      extension['config'] = { fit: true } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'fit', controllerProps: { value: true } },
        { key: 'fit_target', controllerProps: { value: '1024' } },
        { key: 'fit_ctx', controllerProps: { value: '' } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateFitDefault']()

      const updatedSettings = vi.mocked(extension['updateSettings']).mock
        .calls[0][0]
      expect(
        updatedSettings.find((s: any) => s.key === 'fit_target').controllerProps
          .value
      ).toBe('1024')
      expect(
        updatedSettings.find((s: any) => s.key === 'fit_ctx').controllerProps
          .value
      ).toBe('')
    })
  })

  describe('getLoadedModels', () => {
    it('should return list of loaded models', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockResolvedValue(['model1', 'model2'])

      const result = await extension.getLoadedModels()

      expect(result).toEqual(['model1', 'model2'])
    })
  })

  describe('updateBackend', () => {
    beforeEach(() => {
      vi.stubGlobal('IS_WINDOWS', false)
      extension['config'] = {
        version_backend: 'v1.0.0/linux-avx2-x64',
        device: '',
      } as any
    })

    afterEach(() => {
      vi.unstubAllGlobals()
    })

    describe('validation', () => {
      it('should reject empty targetBackendString', async () => {
        const result = await extension.updateBackend('')
        expect(result).toEqual({
          wasUpdated: false,
          newBackend: 'v1.0.0/linux-avx2-x64',
        })
      })

      it('should reject targetBackendString with no slash', async () => {
        const result = await extension.updateBackend('v1.2.3')
        expect(result).toEqual({
          wasUpdated: false,
          newBackend: 'v1.0.0/linux-avx2-x64',
        })
      })

      it('should reject targetBackendString with trailing slash', async () => {
        const result = await extension.updateBackend('v1.2.3/')
        expect(result).toEqual({
          wasUpdated: false,
          newBackend: 'v1.0.0/linux-avx2-x64',
        })
      })

      it('should reject targetBackendString with leading slash', async () => {
        const result = await extension.updateBackend('/linux-avx2-x64')
        expect(result).toEqual({
          wasUpdated: false,
          newBackend: 'v1.0.0/linux-avx2-x64',
        })
      })

      it('should reject targetBackendString with extra segments', async () => {
        const result = await extension.updateBackend('v1/backend/extra')
        expect(result).toEqual({
          wasUpdated: false,
          newBackend: 'v1.0.0/linux-avx2-x64',
        })
      })

      it('should reject targetBackendString with whitespace-only parts', async () => {
        const result = await extension.updateBackend(' / ')
        expect(result).toEqual({
          wasUpdated: false,
          newBackend: 'v1.0.0/linux-avx2-x64',
        })
      })
    })

    describe('isUpdatingBackend flag', () => {
      it('should reset isUpdatingBackend to false after successful update', async () => {
        extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)
        extension['getStoredBackendType'] = vi
          .fn()
          .mockReturnValue('linux-avx2-x64')
        extension['setStoredBackendType'] = vi.fn()
        extension['getSettings'] = vi.fn().mockResolvedValue([])
        extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

        const { getJanDataFolderPath, joinPath } = await import('@janhq/core')
        vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
        vi.mocked(joinPath).mockResolvedValue('/path/to/jan/llamacpp/backends')

        const { mapOldBackendToNew, removeOldBackendVersions } = await import(
          '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
        )
        vi.mocked(mapOldBackendToNew).mockResolvedValue('linux-avx2-x64')
        vi.mocked(removeOldBackendVersions).mockResolvedValue([])

        expect(extension['isUpdatingBackend']).toBe(false)

        await extension.updateBackend('v2.0.0/linux-avx2-x64')

        expect(extension['isUpdatingBackend']).toBe(false)
      })

      it('should reset isUpdatingBackend to false after failed update', async () => {
        extension['ensureBackendReady'] = vi
          .fn()
          .mockRejectedValue(new Error('download failed'))

        expect(extension['isUpdatingBackend']).toBe(false)

        const result = await extension.updateBackend('v2.0.0/linux-avx2-x64')

        expect(extension['isUpdatingBackend']).toBe(false)
        expect(result.wasUpdated).toBe(false)
      })

      it('should return no-op when an update is already in progress', async () => {
        // Simulate an update already in progress
        extension['isUpdatingBackend'] = true

        const result = await extension.updateBackend('v2.0.0/linux-avx2-x64')
        expect(result.wasUpdated).toBe(false)
      })
    })

    describe('onSettingUpdate guard', () => {
      it('should skip ensureBackendReady in onSettingUpdate when updateBackend is in progress', async () => {
        extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)

        // Simulate updateBackend in progress
        extension['isUpdatingBackend'] = true

        // Call onSettingUpdate while updateBackend is "running"
        extension.onSettingUpdate('version_backend', 'v2.0.0/linux-avx2-x64')

        // ensureBackendReady should NOT have been called from onSettingUpdate
        expect(extension['ensureBackendReady']).not.toHaveBeenCalled()
      })
    })

    describe('stored backend type', () => {
      it('should store effectiveBackendType, not the full version/backend string', async () => {
        extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)
        extension['getStoredBackendType'] = vi
          .fn()
          .mockReturnValue('old-backend-type')
        extension['setStoredBackendType'] = vi.fn()
        extension['getSettings'] = vi.fn().mockResolvedValue([])
        extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

        const { getJanDataFolderPath, joinPath } = await import('@janhq/core')
        vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
        vi.mocked(joinPath).mockResolvedValue('/path/to/jan/llamacpp/backends')

        const { mapOldBackendToNew, removeOldBackendVersions } = await import(
          '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
        )
        vi.mocked(mapOldBackendToNew).mockResolvedValue('linux-avx2-x64')
        vi.mocked(removeOldBackendVersions).mockResolvedValue([])

        const result = await extension.updateBackend('v2.0.0/linux-avx2-x64')

        expect(result.wasUpdated).toBe(true)
        expect(extension['setStoredBackendType']).toHaveBeenCalledWith(
          'linux-avx2-x64'
        )
      })
    })

    describe('trimming', () => {
      it('should trim whitespace from version and backend before use', async () => {
        extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)
        extension['getStoredBackendType'] = vi
          .fn()
          .mockReturnValue('linux-avx2-x64')
        extension['setStoredBackendType'] = vi.fn()
        extension['getSettings'] = vi.fn().mockResolvedValue([])
        extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

        const { getJanDataFolderPath, joinPath } = await import('@janhq/core')
        vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
        vi.mocked(joinPath).mockResolvedValue('/path/to/jan/llamacpp/backends')

        const { mapOldBackendToNew, removeOldBackendVersions } = await import(
          '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
        )
        vi.mocked(mapOldBackendToNew).mockResolvedValue('linux-avx2-x64')
        vi.mocked(removeOldBackendVersions).mockResolvedValue([])

        await extension.updateBackend(' v2.0.0 / linux-avx2-x64 ')

        // ensureBackendReady should receive trimmed values
        expect(extension['ensureBackendReady']).toHaveBeenCalledWith(
          'linux-avx2-x64',
          'v2.0.0'
        )
      })
    })
  })

  describe('backend replacement', () => {
    const RECOMMENDED = 'v1.2.0/windows-x64-cuda-13.3'
    const PENDING_KEY = 'turboquant_pending_backend'
    const RECOMMENDATION_KEY = 'turboquant_better_backend_recommendation'
    const OPTIMAL_CACHE_KEY =
      'atomic_llamacpp_turboquant_optimal_backend_v1'

    /**
     * `updateBackend` fans out to the settings store, the stored-type
     * preference and the guest bridge. Stub all of it so these tests can
     * assert *what ends up persisted* after a replacement.
     */
    const stubUpdateBackendDeps = async (storedType: string) => {
      extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)
      extension['getStoredBackendType'] = vi.fn().mockReturnValue(storedType)
      extension['setStoredBackendType'] = vi.fn()
      extension['getSettings'] = vi
        .fn()
        .mockResolvedValue([
          { key: 'version_backend', controllerProps: { value: '' } },
        ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      const { getJanDataFolderPath, joinPath } = await import('@janhq/core')
      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockResolvedValue('/path/to/jan/llamacpp/backends')

      const { mapOldBackendToNew, removeOldBackendVersions } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(mapOldBackendToNew).mockImplementation(async (b: string) => b)
      vi.mocked(removeOldBackendVersions).mockResolvedValue([])
    }

    const persistedVersionBackend = () => {
      const calls = vi.mocked(extension['updateSettings']).mock.calls
      const settings = calls[calls.length - 1]?.[0] as any[] | undefined
      return settings?.find((s) => s.key === 'version_backend')?.controllerProps
        .value
    }

    beforeEach(() => {
      vi.stubGlobal('IS_MAC', false)
      vi.stubGlobal('IS_WINDOWS', false)
      vi.mocked(localStorage.getItem).mockReset()
      vi.mocked(localStorage.setItem).mockReset()
      vi.mocked(localStorage.removeItem).mockReset()
      extension['config'] = {
        version_backend: 'v1.0.0/windows-x64-cpu',
        device: '',
      } as any
    })

    afterEach(() => {
      delete (window as any).dispatchEvent
    })

    describe('version update', () => {
      it('bumps the version and keeps the backend type', async () => {
        await stubUpdateBackendDeps('windows-x64-cuda-13.3')
        extension['config'] = {
          version_backend: 'v1.0.0/windows-x64-cuda-13.3',
          device: '',
        } as any

        const result = await extension.updateBackend(RECOMMENDED)

        expect(result).toEqual({ wasUpdated: true, newBackend: RECOMMENDED })
        expect(extension['ensureBackendReady']).toHaveBeenCalledWith(
          'windows-x64-cuda-13.3',
          'v1.2.0'
        )
        expect(persistedVersionBackend()).toBe(RECOMMENDED)
        expect(extension['config'].version_backend).toBe(RECOMMENDED)
        // The type is unchanged, so the stored preference must be left alone.
        expect(extension['setStoredBackendType']).not.toHaveBeenCalled()
      })

      it('records the new type when the update also switches tier', async () => {
        await stubUpdateBackendDeps('windows-x64-cpu')

        await extension.updateBackend(RECOMMENDED)

        expect(persistedVersionBackend()).toBe(RECOMMENDED)
        expect(extension['setStoredBackendType']).toHaveBeenCalledWith(
          'windows-x64-cuda-13.3'
        )
      })
    })

    describe('applyBackendLive', () => {
      it('persists the new backend before unloading any model', async () => {
        const order: string[] = []
        extension['getLoadedModels'] = vi.fn().mockResolvedValue(['m1', 'm2'])
        extension.updateBackend = vi.fn(async () => {
          order.push('updateBackend')
          return { wasUpdated: true, newBackend: RECOMMENDED }
        })
        extension.unload = vi.fn(async (modelId: string) => {
          order.push(`unload:${modelId}`)
          return { success: true } as any
        })
        ;(window as any).dispatchEvent = vi.fn()

        await extension['applyBackendLive'](RECOMMENDED)

        // An unload flips the model to stopped, which makes the web app
        // auto-reload it; the new backend has to be committed by then.
        expect(order).toEqual(['updateBackend', 'unload:m1', 'unload:m2'])
        expect(localStorage.removeItem).toHaveBeenCalledWith(PENDING_KEY)

        const event = vi.mocked((window as any).dispatchEvent).mock
          .calls[0][0] as CustomEvent
        expect(event.type).toBe('app:backend-hotswapped')
        // The detail names its provider so the other llama provider's popup
        // ignores this swap instead of completing on it.
        expect(event.detail).toEqual({
          backend: RECOMMENDED,
          provider: 'llamacpp',
          version: 'v1.2.0',
          backendId: 'windows-x64-cuda-13.3',
        })
      })

      it('keeps loaded models alive when the swap cannot be persisted', async () => {
        extension['getLoadedModels'] = vi.fn().mockResolvedValue(['m1'])
        extension.updateBackend = vi.fn().mockResolvedValue({
          wasUpdated: false,
          newBackend: 'v1.0.0/windows-x64-cpu',
        })
        extension.unload = vi.fn()

        await expect(
          extension['applyBackendLive'](RECOMMENDED)
        ).rejects.toThrow(/wasUpdated=false/)

        expect(extension.unload).not.toHaveBeenCalled()
        expect(localStorage.removeItem).not.toHaveBeenCalledWith(PENDING_KEY)
      })

      it('still swaps when the loaded-model probe fails', async () => {
        extension['getLoadedModels'] = vi
          .fn()
          .mockRejectedValue(new Error('server unreachable'))
        extension.updateBackend = vi
          .fn()
          .mockResolvedValue({ wasUpdated: true, newBackend: RECOMMENDED })
        extension.unload = vi.fn()

        await extension['applyBackendLive'](RECOMMENDED)

        expect(extension.updateBackend).toHaveBeenCalledWith(RECOMMENDED)
        expect(extension.unload).not.toHaveBeenCalled()
      })
    })

    describe('downloadRecommendedBackend', () => {
      it('marks the backend pending before downloading, then swaps to it', async () => {
        const order: string[] = []
        vi.mocked(localStorage.setItem).mockImplementation((key: string) => {
          order.push(`pending:${key}`)
        })
        extension['downloadAndInstallBackend'] = vi.fn(async () => {
          order.push('download')
        })
        extension['applyBackendLive'] = vi.fn(async (backend: string) => {
          order.push(`apply:${backend}`)
        })

        await extension.downloadRecommendedBackend(RECOMMENDED)

        expect(order).toEqual([
          `pending:${PENDING_KEY}`,
          'download',
          `apply:${RECOMMENDED}`,
        ])
        expect(localStorage.removeItem).toHaveBeenCalledWith(RECOMMENDATION_KEY)
      })

      it('drops the pending marker when the download fails', async () => {
        extension['downloadAndInstallBackend'] = vi
          .fn()
          .mockRejectedValue(new Error('asset 404'))
        extension['applyBackendLive'] = vi.fn()

        await expect(
          extension.downloadRecommendedBackend(RECOMMENDED)
        ).rejects.toThrow('asset 404')

        expect(localStorage.removeItem).toHaveBeenCalledWith(PENDING_KEY)
        expect(extension['applyBackendLive']).not.toHaveBeenCalled()
      })

      it('leaves the pending marker for the next launch when the hot-swap fails', async () => {
        extension['downloadAndInstallBackend'] = vi
          .fn()
          .mockResolvedValue(undefined)
        extension['applyBackendLive'] = vi
          .fn()
          .mockRejectedValue(new Error('model still running'))

        await extension.downloadRecommendedBackend(RECOMMENDED)

        expect(localStorage.removeItem).not.toHaveBeenCalledWith(PENDING_KEY)
      })
    })

    describe('activatePendingBackend', () => {
      beforeEach(() => {
        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === PENDING_KEY ? RECOMMENDED : null
        )
      })

      it('activates a backend downloaded before the last restart', async () => {
        const { isBackendInstalled } = await import('../backend')
        vi.mocked(isBackendInstalled).mockResolvedValue(true)
        extension.updateBackend = vi
          .fn()
          .mockResolvedValue({ wasUpdated: true, newBackend: RECOMMENDED })

        await extension['activatePendingBackend']()

        expect(extension.updateBackend).toHaveBeenCalledWith(RECOMMENDED)
        expect(localStorage.removeItem).toHaveBeenCalledWith(PENDING_KEY)
      })

      it('clears a pending backend that never made it to disk', async () => {
        const { isBackendInstalled } = await import('../backend')
        vi.mocked(isBackendInstalled).mockResolvedValue(false)
        extension.updateBackend = vi.fn()

        await extension['activatePendingBackend']()

        expect(extension.updateBackend).not.toHaveBeenCalled()
        expect(localStorage.removeItem).toHaveBeenCalledWith(PENDING_KEY)
      })
    })

    describe('recheckOptimalBackend', () => {
      it('recommends the catalog entry for the detected GPU tier', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'windows-x64-cuda-13.3',
        })
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'v1.1.0', backend: 'windows-x64-cpu', order: 0 },
          { version: 'v1.2.0', backend: 'windows-x64-cuda-13.3', order: 0 },
        ])

        const result = await extension.recheckOptimalBackend()

        // Each turboquant variant ships in its own release, so the tag has to
        // come from the catalog entry rather than the current backend.
        expect(result).toMatchObject({
          currentBackend: 'v1.0.0/windows-x64-cpu',
          recommendedBackend: RECOMMENDED,
          provider: 'llamacpp',
        })
        expect(localStorage.setItem).toHaveBeenCalledWith(
          RECOMMENDATION_KEY,
          JSON.stringify(result)
        )

        const { events, AppEvent } = await import('@janhq/core')
        expect(events.emit).toHaveBeenCalledWith(
          AppEvent.onBetterBackendDetected,
          result
        )
      })

      it('returns nothing and forgets any stale recommendation when already optimal', async () => {
        extension['config'] = {
          version_backend: RECOMMENDED,
          device: '',
        } as any
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'windows-x64-cuda-13.3',
        })

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(localStorage.removeItem).toHaveBeenCalledWith(RECOMMENDATION_KEY)
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          expect.any(String)
        )
        expect(localStorage.setItem).not.toHaveBeenCalledWith(
          RECOMMENDATION_KEY,
          expect.anything()
        )
      })

      it('returns nothing when CPU genuinely is the best this host can do', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'cpu-optimal',
        })

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          expect.any(String)
        )
      })

      it('skips the recommendation when the tier has no catalog entry', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'windows-x64-cuda-13.3',
        })
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'v1.1.0', backend: 'windows-x64-cpu', order: 0 },
        ])

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          expect.any(String)
        )
      })

      it('raises a distinct signal when detection could not complete', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'detection-failed',
        })

        await expect(extension.recheckOptimalBackend()).rejects.toThrow(
          'BACKEND_DETECTION_FAILED'
        )

        // The current backend and any earlier recommendation stay untouched.
        expect(localStorage.setItem).not.toHaveBeenCalled()
        expect(localStorage.removeItem).not.toHaveBeenCalled()
      })
    })

    describe('optimal backend cache', () => {
      it('caches a resolved GPU optimum without surfacing a recommendation', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_722_345_678_901)
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'windows-x64-cuda-13.3',
        })
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'v1.2.0', backend: 'windows-x64-cuda-13.3', order: 0 },
        ])

        const result = await extension.refreshOptimalBackendCache()

        expect(result).toEqual({
          schemaVersion: 1,
          detectedAt: 1_722_345_678_901,
          provider: 'llamacpp',
          detectionKind: 'gpu',
          currentBackend: 'v1.0.0/windows-x64-cpu',
          idealBackendId: 'windows-x64-cuda-13.3',
          recommendedBackend: RECOMMENDED,
          recommendedCategory: 'CUDA 13',
        })
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          JSON.stringify(result)
        )
        expect(localStorage.setItem).not.toHaveBeenCalledWith(
          RECOMMENDATION_KEY,
          expect.anything()
        )

        const { events, AppEvent } = await import('@janhq/core')
        expect(events.emit).not.toHaveBeenCalledWith(
          AppEvent.onBetterBackendDetected,
          expect.anything()
        )
      })

      it('caches a genuine CPU optimum', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'cpu-optimal',
        })

        const result = await extension.refreshOptimalBackendCache()

        expect(result).toMatchObject({
          schemaVersion: 1,
          provider: 'llamacpp',
          detectionKind: 'cpu-optimal',
          currentBackend: 'v1.0.0/windows-x64-cpu',
          recommendedCategory: 'CPU',
        })
        expect(result).not.toHaveProperty('idealBackendId')
        expect(result).not.toHaveProperty('recommendedBackend')
      })

      it('uses the confirmed CPU-only fast path without hardware detection', async () => {
        const detect = vi.spyOn(extension as any, 'detectIdealBackendType')

        const result = await extension.refreshOptimalBackendCache({
          hardwareHasNoGpu: true,
        })

        expect(result.detectionKind).toBe('cpu-optimal')
        expect(detect).not.toHaveBeenCalled()
        expect(listSupportedBackends).not.toHaveBeenCalled()
      })

      it('preserves the previous successful cache when detection fails', async () => {
        const previous = {
          schemaVersion: 1,
          detectedAt: 1_700_000_000_000,
          provider: 'llamacpp',
          detectionKind: 'gpu',
          currentBackend: 'v1/windows-x64-cpu',
          idealBackendId: 'windows-x64-vulkan',
          recommendedBackend: 'v2/windows-x64-vulkan',
          recommendedCategory: 'Vulkan',
        }
        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === OPTIMAL_CACHE_KEY ? JSON.stringify(previous) : null
        )
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'detection-failed',
        })

        await expect(extension.refreshOptimalBackendCache()).rejects.toThrow(
          'BACKEND_DETECTION_FAILED'
        )

        expect(localStorage.setItem).not.toHaveBeenCalled()
        expect(localStorage.removeItem).not.toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY
        )
        expect(extension.getCachedOptimalBackend()).toEqual(previous)
      })

      it('returns null for an invalid persisted cache record', () => {
        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === OPTIMAL_CACHE_KEY
            ? JSON.stringify({
                schemaVersion: 2,
                provider: 'llamacpp',
                detectionKind: 'gpu',
              })
            : null
        )

        expect(extension.getCachedOptimalBackend()).toBeNull()
      })

      it('prefers the cached GPU optimum and falls back to the old recommendation', async () => {
        const { events } = await import('@janhq/core')
        extension['getSetting'] = vi
          .fn()
          .mockResolvedValue('v1.0.0/windows-x64-cpu')
        extension['effectiveVersionBackend'] =
          'v1.0.0/windows-x64-cpu'
        const recommendation = {
          recommendedBackend: 'v2.0.0/windows-x64-vulkan',
        }
        const cache = {
          schemaVersion: 1,
          detectedAt: 1_700_000_000_000,
          provider: 'llamacpp',
          detectionKind: 'gpu',
          currentBackend: 'v1.0.0/windows-x64-cpu',
          idealBackendId: 'windows-x64-cuda-13.3',
          recommendedBackend: RECOMMENDED,
          recommendedCategory: 'CUDA 13',
        }
        vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
          if (key === OPTIMAL_CACHE_KEY) return JSON.stringify(cache)
          if (key === RECOMMENDATION_KEY) return JSON.stringify(recommendation)
          return null
        })

        await extension['reportBackendMismatch'](
          {
            model_id: 'fixture-model',
            pid: 1,
            runtime_device: { primary_device: 'CPU_Mapped' },
          } as any,
          false
        )

        let payload = vi.mocked(events.emit).mock.calls.at(-1)?.[1] as any
        expect(payload.mismatch).toMatchObject({
          kind: 'suboptimal-config',
          ideal: 'windows-x64-cuda-13.3',
        })

        vi.mocked(events.emit).mockClear()
        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === RECOMMENDATION_KEY ? JSON.stringify(recommendation) : null
        )

        await extension['reportBackendMismatch'](
          {
            model_id: 'fixture-model',
            pid: 1,
            runtime_device: { primary_device: 'CPU_Mapped' },
          } as any,
          false
        )

        payload = vi.mocked(events.emit).mock.calls.at(-1)?.[1] as any
        expect(payload.mismatch).toMatchObject({
          kind: 'suboptimal-config',
          ideal: 'windows-x64-vulkan',
        })
      })
    })
  })

  /// An app update only reshuffles the bundled tier — CPU on Windows, Vulkan
  /// on Linux. Anyone whose GPU tier was fetched at runtime keeps the tag they
  /// first downloaded unless something pulls them forward, and the hardware
  /// popup won't: it compares categories, and a CUDA user is already optimal.
  describe('reconcileBackendReleaseTag', () => {
    const CURRENT = 'b9937-1.2.0/windows-x64-cuda-13.3'
    const TARGET = 'b10018-1.3.0/windows-x64-cuda-13.3'

    const stubReconcileDeps = async () => {
      extension['downloadRecommendedBackend'] = vi
        .fn()
        .mockResolvedValue(undefined)
      const { mapOldBackendToNew } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(mapOldBackendToNew).mockImplementation(async (b: string) => b)
    }

    beforeEach(async () => {
      vi.stubGlobal('IS_MAC', false)
      extension['config'] = { version_backend: CURRENT } as any
      await stubReconcileDeps()
    })

    it('pulls a runtime-downloaded GPU tier onto the new release tag', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10018-1.3.0',
        targetBackend: TARGET,
      })

      await extension['reconcileBackendReleaseTag']()

      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(
        TARGET
      )
    })

    it('leaves a user who already runs the newest tag alone', async () => {
      extension.checkBackendForUpdates = vi
        .fn()
        .mockResolvedValue({ updateNeeded: false, newVersion: '0' })

      await extension['reconcileBackendReleaseTag']()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('updates the engine on macOS too, without an app release', async () => {
      vi.stubGlobal('IS_MAC', true)
      extension['config'] = {
        version_backend: 'b9937-1.2.0/macos-arm64',
      } as any
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10018-1.3.0',
        targetBackend: 'b10018-1.3.0/macos-arm64',
      })

      await extension['reconcileBackendReleaseTag']()

      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(
        'b10018-1.3.0/macos-arm64'
      )
    })

    it('refuses to move onto a legacy prerelease found on disk', async () => {
      extension['config'] = {
        version_backend: 'b9937-1.2.0/linux-x64-vulkan',
      } as any
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'turboquant-linux-x64-vulkan-d86eb0b',
        targetBackend: 'turboquant-linux-x64-vulkan-d86eb0b/linux-x64-vulkan',
      })

      await extension['reconcileBackendReleaseTag']()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('skips while no concrete backend is configured yet', async () => {
      extension['config'] = { version_backend: 'none' } as any
      extension.checkBackendForUpdates = vi.fn()

      await extension['reconcileBackendReleaseTag']()

      expect(extension.checkBackendForUpdates).not.toHaveBeenCalled()
    })

    it('refuses a target that would change the backend family', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10018-1.3.0',
        targetBackend: 'b10018-1.3.0/windows-x64-cpu',
      })

      await extension['reconcileBackendReleaseTag']()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('accepts a target that is the migrated form of a legacy id', async () => {
      extension['config'] = { version_backend: 'b9937/linux-avx2-x64' } as any
      const { mapOldBackendToNew } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(mapOldBackendToNew).mockResolvedValue('linux-x64-vulkan')
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10018-1.3.0',
        targetBackend: 'b10018-1.3.0/linux-x64-vulkan',
      })

      await extension['reconcileBackendReleaseTag']()

      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(
        'b10018-1.3.0/linux-x64-vulkan'
      )
    })

    it('keeps the working backend when the download fails', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10018-1.3.0',
        targetBackend: TARGET,
      })
      extension['downloadRecommendedBackend'] = vi
        .fn()
        .mockRejectedValue(new Error('network down'))

      await expect(
        extension['reconcileBackendReleaseTag']()
      ).resolves.toBeUndefined()
      expect(extension['config'].version_backend).toBe(CURRENT)
    })

    it('survives a detection failure without touching the backend', async () => {
      extension.checkBackendForUpdates = vi
        .fn()
        .mockRejectedValue(new Error('manifest unreachable'))

      await expect(
        extension['reconcileBackendReleaseTag']()
      ).resolves.toBeUndefined()
      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
      expect(extension['config'].version_backend).toBe(CURRENT)
    })
  })

  /// The version list and the release index are both snapshots taken at load,
  /// so without an explicit refetch a release published mid-session is
  /// invisible until the app restarts.
  describe('checkForEngineUpdate', () => {
    const CURRENT = 'b9937-1.2.0/macos-arm64'
    const TARGET = 'b10269-1.4.0/macos-arm64'

    beforeEach(async () => {
      vi.stubGlobal('IS_MAC', true)
      extension['config'] = { version_backend: CURRENT } as any
      extension['configureBackendsPromise'] = null
      extension['downloadRecommendedBackend'] = vi
        .fn()
        .mockResolvedValue(undefined)
      const { mapOldBackendToNew } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(mapOldBackendToNew).mockImplementation(async (b: string) => b)
    })

    it('force-refetches the index and names the release to install', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10269-1.4.0',
        targetBackend: TARGET,
      })

      const result = await extension.checkForEngineUpdate()

      expect(extension.checkBackendForUpdates).toHaveBeenCalledWith({
        force: true,
      })
      expect(result).toEqual({
        updateAvailable: true,
        targetBackend: TARGET,
      })
    })

    /// Downloading is the caller's job — awaiting it inside the check is what
    /// pinned the settings button in its loading state for the whole archive.
    it('leaves the download to the caller', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10269-1.4.0',
        targetBackend: TARGET,
      })

      await extension.checkForEngineUpdate()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('reports no update when the newest stable is already running', async () => {
      extension.checkBackendForUpdates = vi
        .fn()
        .mockResolvedValue({ updateNeeded: false, newVersion: '0' })

      await expect(extension.checkForEngineUpdate()).resolves.toEqual({
        updateAvailable: false,
        targetBackend: null,
      })
    })

    it('refuses a legacy prerelease that only exists on disk', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'turboquant-macos-arm64-d86eb0b',
        targetBackend: 'turboquant-macos-arm64-d86eb0b/macos-arm64',
      })

      const result = await extension.checkForEngineUpdate()

      expect(result.updateAvailable).toBe(false)
    })

    it('refuses to cross backend families', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10269-1.4.0',
        targetBackend: 'b10269-1.4.0/linux-x64-cuda-13.3',
      })

      const result = await extension.checkForEngineUpdate()

      expect(result.updateAvailable).toBe(false)
    })

    /// An unreachable or rate-limited GitHub used to leave the button
    /// spinning forever, because the catalog lookup had no deadline.
    it('settles on a deadline when the catalog never answers', async () => {
      vi.useFakeTimers()
      try {
        extension.checkBackendForUpdates = vi
          .fn()
          .mockReturnValue(new Promise(() => {}))

        const pending = extension.checkForEngineUpdate()
        await vi.advanceTimersByTimeAsync(20_000)

        await expect(pending).resolves.toEqual({
          updateAvailable: false,
          targetBackend: null,
        })
      } finally {
        vi.useRealTimers()
      }
    })
  })

  /// A clean install used to show CUDA in the dropdown while quietly running
  /// the bundled CPU build forever, unless the user walked through onboarding.
  describe('adoptOptimalBackendOnFirstRun', () => {
    const BUNDLED = 'b10018-1.3.0/windows-x64-cpu'
    const CUDA = 'b10269-1.4.0/windows-x64-cuda-13.3'
    const CATALOG = [
      { version: 'b10269-1.4.0', backend: 'windows-x64-cpu' },
      { version: 'b10269-1.4.0', backend: 'windows-x64-cuda-13.3' },
    ]

    const adopt = (storedType: string | null, active = BUNDLED) =>
      extension['adoptOptimalBackendOnFirstRun'](
        storedType,
        active,
        BUNDLED,
        CATALOG
      )

    beforeEach(async () => {
      vi.stubGlobal('IS_MAC', false)
      extension['downloadRecommendedBackend'] = vi
        .fn()
        .mockResolvedValue(undefined)
      extension['detectOptimalBackend'] = vi.fn().mockResolvedValue({
        kind: 'gpu-optimal',
        backend: 'windows-x64-cuda-13.3',
      })
      extension['resolveConcreteBackend'] = vi.fn().mockResolvedValue(CUDA)

      const { findLatestVersionForBackend } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(findLatestVersionForBackend).mockImplementation(
        async (_catalog: any, type: string) =>
          CATALOG.some((entry) => entry.backend === type)
            ? `b10269-1.4.0/${type}`
            : null
      )
    })

    it('fetches the CUDA build a discrete NVIDIA host wants', async () => {
      await adopt(null)
      await extension['firstRunAdoption']

      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(CUDA)
    })

    it('leaves a user who already picked a backend untouched', async () => {
      await adopt('windows-x64-cpu')

      expect(extension['detectOptimalBackend']).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('does not re-detect for someone already off the bundled build', async () => {
      await adopt(null, CUDA)

      expect(extension['detectOptimalBackend']).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    // Download interrupted, app reopened: the preference is recorded but the
    // bundled build is still what runs. Resume it instead of asking hardware.
    it('finishes an adoption that never landed on disk', async () => {
      await adopt('windows-x64-cuda-13.3')
      await extension['firstRunAdoption']

      expect(extension['detectOptimalBackend']).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(CUDA)
    })

    it('stays on the bundled build when CPU is genuinely optimal', async () => {
      extension['detectOptimalBackend'] = vi
        .fn()
        .mockResolvedValue({ kind: 'cpu-optimal' })

      await adopt(null)

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    // Recording CPU here would look like a deliberate user preference forever
    // after, which ADR 2026-06-15 forbids.
    it('pins nothing when hardware detection fails', async () => {
      extension['detectOptimalBackend'] = vi
        .fn()
        .mockRejectedValue(new Error('BACKEND_DETECTION_FAILED'))

      await expect(adopt(null)).resolves.toBeUndefined()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
      expect(extension['firstRunAdoption']).toBeNull()
    })

    it('pins nothing when the catalog has no build for this hardware', async () => {
      extension['resolveConcreteBackend'] = vi.fn().mockResolvedValue(undefined)

      await adopt(null)

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('keeps serving the bundled build when the download fails', async () => {
      extension['downloadRecommendedBackend'] = vi
        .fn()
        .mockRejectedValue(new Error('network down'))

      await adopt(null)

      await expect(extension['firstRunAdoption']).resolves.toBeUndefined()
    })

    it('does not run on macOS, which publishes a single variant', async () => {
      vi.stubGlobal('IS_MAC', true)

      await extension['adoptOptimalBackendOnFirstRun'](
        null,
        'b10018-1.3.0/macos-arm64',
        'b10018-1.3.0/macos-arm64',
        [{ version: 'b10269-1.4.0', backend: 'macos-arm64' }]
      )

      expect(extension['detectOptimalBackend']).not.toHaveBeenCalled()
    })
  })

  /// The archive id is an implementation detail of hardware detection; what a
  /// user chooses between is accelerator family and what the release changed.
  describe('describeBackendOption', () => {
    it('names the accelerator family and the release notes, never the archive id', () => {
      const label = extension['describeBackendOption'](
        'b10269-1.4.0',
        'windows-x64-cuda-13.3',
        {
          title: 'TurboQuant b10269-1.4.0',
          highlights: ['DeepSeek V4 Flash support', 'Kimi K3 vision'],
        },
        true
      )

      expect(label).toBe(
        'NVIDIA CUDA 13 · b10269-1.4.0 (latest stable) — DeepSeek V4 Flash support, Kimi K3 vision'
      )
      expect(label).not.toContain('windows-x64')
    })

    it('marks only the newest stable release as such', () => {
      expect(
        extension['describeBackendOption'](
          'b10018-1.3.0',
          'linux-x64-rocm',
          undefined,
          false
        )
      ).toBe('AMD ROCm · b10018-1.3.0')
    })

    it('falls back to a bare tag when a legacy build has no release notes', () => {
      expect(
        extension['describeBackendOption'](
          'turboquant-linux-x64-vulkan-d86eb0b',
          'linux-x64-vulkan',
          { highlights: ['   '] },
          false
        )
      ).toBe('Vulkan · turboquant-linux-x64-vulkan-d86eb0b')
    })
  })
})

describe('normalizeLlamacppConfig', () => {
  describe('parallel field', () => {
    it('should default parallel to 1 when undefined', () => {
      const result = normalizeLlamacppConfig({})
      expect(result.parallel).toBe(1)
    })

    it('should default parallel to 1 when null', () => {
      const result = normalizeLlamacppConfig({ parallel: null })
      expect(result.parallel).toBe(1)
    })

    it('should default parallel to 1 when empty string', () => {
      const result = normalizeLlamacppConfig({ parallel: '' })
      expect(result.parallel).toBe(1)
    })

    it('should parse parallel as a number', () => {
      const result = normalizeLlamacppConfig({ parallel: 4 })
      expect(result.parallel).toBe(4)
    })

    it('should parse parallel from a string number', () => {
      const result = normalizeLlamacppConfig({ parallel: '2' })
      expect(result.parallel).toBe(2)
    })

    it('should allow parallel of 0 (disables the flag)', () => {
      const result = normalizeLlamacppConfig({ parallel: 0 })
      expect(result.parallel).toBe(0)
    })
  })

  it('preserves reasoning and extra argument settings for IPC', () => {
    const result = normalizeLlamacppConfig({
      reasoning_preserve: 'true',
      extra_args: '--reasoning-format deepseek',
    })

    expect(result.reasoning_preserve).toBe(true)
    expect(result.extra_args).toBe('--reasoning-format deepseek')
  })

  it('defaults reasoning preservation and extra arguments safely', () => {
    const result = normalizeLlamacppConfig({})

    expect(result.reasoning_preserve).toBe(false)
    expect(result.extra_args).toBe('')
  })
})
