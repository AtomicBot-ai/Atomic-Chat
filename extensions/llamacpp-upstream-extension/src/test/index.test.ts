import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import llamacpp_extension, {
  BACKEND_DETECTION_FAILED,
  OPTIMAL_BACKEND_CACHE_KEY,
} from '../index'

import {
  getSupportedFeaturesFromRust,
  loadLlamaModel,
  mapOldBackendToNew,
  normalizeLlamacppConfig,
  readGgufMetadata,
  removeOldBackendVersions,
  unloadLlamaModel,
} from '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
import {
  getBackendDir,
  isBackendInstalled,
  listSupportedBackends,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { fs, joinPath } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { basename } from '@tauri-apps/api/path'

// Mock fetch globally
global.fetch = vi.fn()

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock backend functions
vi.mock('../backend', () => ({
  isBackendInstalled: vi.fn(),
  getBackendExePath: vi.fn(),
  listSupportedBackends: vi.fn(),
  getBackendDir: vi.fn(),
}))

vi.mock('../hardware', () => ({
  getSystemInfo: vi.fn(),
  getSystemUsage: vi.fn(),
}))

// The extension imports the guest bridge by relative path, so mock that exact
// module rather than the package alias.
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
      getSupportedFeaturesFromRust: vi.fn(),
      loadLlamaModel: vi.fn(),
      mapOldBackendToNew: vi.fn(),
      readGgufMetadata: vi.fn(),
      removeOldBackendVersions: vi.fn(),
      unloadLlamaModel: vi.fn(),
    }
  }
)

describe('llamacpp_extension', () => {
  let extension: llamacpp_extension

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(readGgufMetadata).mockResolvedValue({
      version: 3,
      tensor_count: 1,
      metadata: { 'general.architecture': 'llama' },
    } as any)
    extension = new llamacpp_extension()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('constructor', () => {
    it('should initialize with correct default values', () => {
      expect(extension.provider).toBe('llamacpp-upstream')
      expect(extension.providerId).toBe('llamacpp-upstream')
      expect(extension.autoUnload).toBe(false)
    })
  })

  describe('installBackend', () => {
    it('normalizes an upstream macOS tarball before validating it', async () => {
      const archivePath = '/downloads/llama-b9702-bin-macos-arm64.tar.gz'
      const backendDir = '/data/llamacpp-upstream/backends/b9702/macos-arm64'
      const expectedBin = `${backendDir}/build/bin/llama-server`

      vi.mocked(basename).mockResolvedValue(
        'llama-b9702-bin-macos-arm64.tar.gz'
      )
      vi.mocked(getBackendDir).mockResolvedValue(backendDir)
      vi.mocked(joinPath).mockImplementation(async (parts: string[]) =>
        parts.join('/')
      )
      vi.mocked(fs.existsSync).mockImplementation(
        (path: string) => path === archivePath || path === expectedBin
      )
      vi.mocked(mapOldBackendToNew).mockResolvedValue('macos-arm64')
      extension['config'] = {} as any
      extension['configureBackends'] = vi.fn().mockResolvedValue(undefined)
      extension['setStoredBackendType'] = vi.fn()
      extension['getSettings'] = vi.fn().mockResolvedValue([])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension.installBackend(archivePath)

      expect(invoke).toHaveBeenNthCalledWith(1, 'decompress', {
        path: archivePath,
        outputDir: backendDir,
      })
      expect(invoke).toHaveBeenNthCalledWith(2, 'normalize_backend_layout', {
        outputDir: backendDir,
        exeName: 'llama-server',
      })
      expect(fs.rm).not.toHaveBeenCalled()
    })

    it('rejects an import when normalization leaves no llama-server binary', async () => {
      const archivePath = '/downloads/llama-b9702-bin-macos-arm64.tar.gz'
      const backendDir = '/data/llamacpp-upstream/backends/b9702/macos-arm64'

      vi.mocked(basename).mockResolvedValue(
        'llama-b9702-bin-macos-arm64.tar.gz'
      )
      vi.mocked(getBackendDir).mockResolvedValue(backendDir)
      vi.mocked(joinPath).mockImplementation(async (parts: string[]) =>
        parts.join('/')
      )
      vi.mocked(fs.existsSync).mockImplementation(
        (path: string) => path === archivePath
      )

      await expect(extension.installBackend(archivePath)).rejects.toThrow(
        'Missing llama-server binary'
      )
      expect(fs.rm).toHaveBeenCalledWith(backendDir)
    })
  })

  describe('hardware backend recommendation', () => {
    const discreteGpu = {
      name: 'Test GPU',
      total_memory: 12 * 1024,
      vendor: 'Test',
      uuid: 'gpu-1',
      driver_version: '1',
      vulkan_info: { device_type: 'DiscreteGpu' },
    }

    it('selects the published CUDA 13 asset on a supported Windows host', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [{ ...discreteGpu, nvidia_info: {} }],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: true,
        cuda13: true,
        vulkan: true,
      })
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
        { version: 'b10205', backend: 'win-cuda-12.4-x64', order: 0 },
        { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
        { version: 'b10205', backend: 'win-vulkan-x64', order: 0 },
      ])
      vi.spyOn(extension as any, 'tierEnumeratesDevices').mockResolvedValue(
        'works'
      )

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-cuda-13.3-x64',
      })
    })

    it('uses Vulkan for a Linux NVIDIA host and ignores CUDA flags', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [{ ...discreteGpu, nvidia_info: {} }],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: true,
        cuda12: true,
        cuda13: true,
        vulkan: true,
      })

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'linux-vulkan-x64',
      })
      expect(listSupportedBackends).not.toHaveBeenCalled()
    })

    /// Paired with the turboquant test of the same host, which picks
    /// `linux-x64-rocm`. Upstream publishes no ROCm build, so a positive ROCm
    /// probe must not pull this provider off Vulkan: the optimal backend
    /// belongs to a provider's release, not to the GPU.
    it('stays on Vulkan for a ROCm-capable AMD Linux host', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [{ ...discreteGpu, vendor: 'AMD', nvidia_info: undefined }],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: false,
        cuda13: false,
        rocm: true,
        vulkan: true,
      } as any)

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'linux-vulkan-x64',
      })
      expect(listSupportedBackends).not.toHaveBeenCalled()
    })

    it('keeps an integrated-only Vulkan host on CPU', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [
          {
            ...discreteGpu,
            name: 'Integrated GPU',
            nvidia_info: undefined,
            vulkan_info: { device_type: 'IntegratedGpu' },
          },
        ],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: true,
      })

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
          cuda11: false,
          cuda12: false,
          cuda13: false,
          vulkan: true,
        })
        // The Vulkan asset is published, so CPU here is a decision about the
        // hardware, not a missing release artefact.
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
          { version: 'b10205', backend: 'win-vulkan-x64', order: 0 },
        ])
        const probe = vi.spyOn(extension as any, 'tierEnumeratesDevices')

        await expect(extension['detectIdealBackendType']()).resolves.toEqual({
          kind: 'cpu-optimal',
        })
        // No tier is worth probing, so no llama-server is spawned.
        expect(probe).not.toHaveBeenCalled()
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
        gpus: [
          integratedGpu('Intel Iris Xe', 'Intel', 16 * 1024),
          { ...discreteGpu, nvidia_info: {} },
        ],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: true,
        cuda13: true,
        vulkan: true,
      })
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
        { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
        { version: 'b10205', backend: 'win-vulkan-x64', order: 0 },
      ])
      vi.spyOn(extension as any, 'tierEnumeratesDevices').mockResolvedValue(
        'works'
      )

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-cuda-13.3-x64',
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
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: true,
      })
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
        { version: 'b10205', backend: 'win-vulkan-x64', order: 0 },
      ])
      vi.spyOn(extension as any, 'tierEnumeratesDevices').mockResolvedValue(
        'works'
      )

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-vulkan-x64',
      })
    })

    it('reports detection failure when a Windows GPU tier has no release asset', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [{ ...discreteGpu, nvidia_info: {} }],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: true,
        cuda13: true,
        vulkan: false,
      })
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'detection-failed',
      })
    })
  })

  describe('backend preference storage', () => {
    it('uses the upstream-specific key', () => {
      vi.mocked(localStorage.getItem).mockReturnValueOnce('win-vulkan-x64')

      expect(extension['getStoredBackendType']()).toBe('win-vulkan-x64')
      expect(localStorage.getItem).toHaveBeenCalledWith(
        'atomic_llamacpp_upstream_backend_type'
      )
    })

    it('migrates a matching legacy upstream preference', () => {
      vi.mocked(localStorage.getItem)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce('win-vulkan-x64')

      expect(extension['getStoredBackendType']()).toBe('win-vulkan-x64')
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'atomic_llamacpp_upstream_backend_type',
        'win-vulkan-x64'
      )
    })

    it('does not import a TurboQuant preference from the shared key', () => {
      vi.mocked(localStorage.getItem)
        .mockReturnValueOnce(null)
        .mockReturnValueOnce('windows-x64-vulkan')

      expect(extension['getStoredBackendType']()).toBeNull()
      expect(localStorage.setItem).not.toHaveBeenCalled()
    })

    it('writes and clears only the upstream-specific key', () => {
      extension['setStoredBackendType']('win-vulkan-x64')
      extension['clearStoredBackendType']()

      expect(localStorage.setItem).toHaveBeenCalledWith(
        'atomic_llamacpp_upstream_backend_type',
        'win-vulkan-x64'
      )
      expect(localStorage.removeItem).toHaveBeenCalledWith(
        'atomic_llamacpp_upstream_backend_type'
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

    it('should return model list when models exist', async () => {
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

      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => {
        if (path === modelsDir) return true
        if (path === `${modelsDir}/test-model/model.yml`) return true
        return false
      })

      vi.mocked(fs.readdirSync).mockResolvedValue(['test-model'])
      vi.mocked(fs.fileStat).mockResolvedValue({
        isDirectory: true,
        size: 1000,
      })

      vi.mocked(invoke).mockResolvedValue({
        model_path: 'test-model/model.gguf',
        name: 'Test Model',
        size_bytes: 1000000,
        embedding: false,
      })

      const result = await extension.list()

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'test-model',
        name: 'Test Model',
        providerId: 'llamacpp-upstream',
        sizeBytes: 1000000,
        embedding: false,
      })
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
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')
      const { invoke } = await import('@tauri-apps/api/core')

      // Mock backend functions to avoid download
      const backendModule = await import('../backend')
      vi.mocked(backendModule.isBackendInstalled).mockResolvedValue(true)
      vi.mocked(backendModule.getBackendExePath).mockResolvedValue(
        '/path/to/backend/executable'
      )

      // Mock fs for backend check
      vi.mocked(fs.existsSync).mockResolvedValue(true)
      vi.mocked(fs.fileStat).mockResolvedValue({
        isDirectory: false,
        size: 1000000,
      })

      // Mock configuration
      extension['config'] = {
        version_backend: 'v1.0.0/win-avx2-x64',
        ctx_size: 2048,
        n_gpu_layers: 10,
        threads: 4,
        chat_template: '',
        threads_batch: 0,
        n_predict: 0,
        batch_size: 0,
        ubatch_size: 0,
        device: '',
        split_mode: '',
        main_gpu: 0,
        flash_attn: false,
        cont_batching: false,
        no_mmap: false,
        mlock: false,
        no_kv_offload: false,
        cache_type_k: 'f16',
        cache_type_v: 'f16',
        defrag_thold: 0.1,
        rope_scaling: 'linear',
        rope_scale: 1.0,
        rope_freq_base: 10000,
        rope_freq_scale: 1.0,
        reasoning_budget: 0,
        auto_unload: true,
      }

      // Set up providerPath
      extension['providerPath'] = '/path/to/jan/llamacpp'
      extension['findSessionByModel'] = vi.fn().mockResolvedValue(undefined)
      extension['getLoadedModels'] = vi.fn().mockResolvedValue([])

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )

      // Mock model config
      vi.mocked(invoke)
        .mockResolvedValueOnce({
          // read_yaml
          model_path: 'test-model/model.gguf',
          name: 'Test Model',
          size_bytes: 1000000,
        })
        .mockResolvedValueOnce('test-api-key') // generate_api_key

      vi.mocked(loadLlamaModel).mockResolvedValue({
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-api-key',
      } as any)

      // Mock successful health check
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: 'ok' }),
      })

      const result = await extension.load('test-model')

      expect(result).toEqual({
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-api-key',
      })

      expect(extension['sessionCache'].get('test-model')).toEqual({
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-api-key',
      })
    })
  })

  describe('unload', () => {
    it('should throw error if no active session found', async () => {
      await expect(extension.unload('nonexistent-model')).rejects.toThrow(
        'No active session found'
      )
    })

    it('should unload model successfully', async () => {
      const { invoke } = await import('@tauri-apps/api/core')

      // Set up active session
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

      // Set up active session
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

        vi.mocked(mapOldBackendToNew).mockResolvedValue('linux-avx2-x64')
        vi.mocked(removeOldBackendVersions).mockResolvedValue([])

        await extension.updateBackend('v2.0.0/linux-avx2-x64')

        // setStoredBackendType should be called with the backend type only, not "version/backend"
        const storedValue = vi.mocked(extension['setStoredBackendType']).mock
          .calls[0]?.[0]
        expect(storedValue).not.toContain('/')
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

    describe('cleanup target directory (ATO-153)', () => {
      it('should resolve the cleanup dir under this provider (llamacpp-upstream), never the shared/turboquant llamacpp dir', async () => {
        extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)
        extension['getStoredBackendType'] = vi
          .fn()
          .mockReturnValue('linux-avx2-x64')
        extension['setStoredBackendType'] = vi.fn()
        extension['getSettings'] = vi.fn().mockResolvedValue([])
        extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

        const { getJanDataFolderPath, joinPath } = await import('@janhq/core')
        vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
        vi.mocked(joinPath).mockImplementation((paths) =>
          Promise.resolve(paths.join('/'))
        )

        // The extension imports the guest-js helpers via a RELATIVE path, so
        // the `@janhq/tauri-plugin-llamacpp-upstream-api` mock does not
        // intercept them — they hit the real Tauri `invoke` bridge. Stub the
        // bridge so `mapOldBackendToNew` / `remove_old_backend_versions` / the
        // log plugin resolve and `updateBackend` reaches the cleanup block.
        const originalTauriInternals = (window as any).__TAURI_INTERNALS__
        ;(window as any).__TAURI_INTERNALS__ = {
          invoke: vi.fn(async (cmd: string, args: any) => {
            if (cmd.endsWith('map_old_backend_to_new')) return args.oldBackend
            if (cmd.endsWith('remove_old_backend_versions')) return []
            return undefined
          }),
        }

        try {
          await extension.updateBackend('v2.0.0/linux-avx2-x64')
        } finally {
          ;(window as any).__TAURI_INTERNALS__ = originalTauriInternals
        }

        // The cleanup MUST build its path from this provider's own tree
        // (`llamacpp-upstream`), so the upstream auto-upgrade never wipes
        // the turboquant `llamacpp/backends` dir (ATO-153).
        expect(joinPath).toHaveBeenCalledWith([
          '/path/to/jan',
          'llamacpp-upstream',
          'backends',
        ])
        expect(joinPath).not.toHaveBeenCalledWith([
          '/path/to/jan',
          'llamacpp',
          'backends',
        ])
      })
    })
  })

  describe('backend replacement', () => {
    const RECOMMENDED = 'b10205/win-cuda-13.3-x64'

    /**
     * `updateBackend` fans out to the settings store, the stored-type
     * preference and the guest bridge. Stub all of it so these tests can
     * assert *what ends up persisted* and *in which order*.
     */
    const stubUpdateBackendDeps = async (storedType: string) => {
      extension['ensureBackendReady'] = vi.fn().mockResolvedValue(undefined)
      extension['ensureBackendOption'] = vi.fn().mockResolvedValue(undefined)
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
      vi.mocked(joinPath).mockResolvedValue(
        '/path/to/jan/llamacpp-upstream/backends'
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
        version_backend: 'b9800/win-cpu-x64',
        device: '',
      } as any
    })

    afterEach(() => {
      delete (window as any).dispatchEvent
    })

    describe('enforcePinnedBackendVersion', () => {
      it('moves the selected backend type to the validated release', async () => {
        extension['config'] = {
          version_backend: 'b9937/win-cuda-13.3-x64',
        } as any
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['enforcePinnedBackendVersion']()

        expect(extension.downloadRecommendedBackend).toHaveBeenCalledWith(
          'b10205/win-cuda-13.3-x64'
        )
      })

      it('leaves the validated release alone', async () => {
        extension['config'] = { version_backend: RECOMMENDED } as any
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['enforcePinnedBackendVersion']()

        expect(extension.downloadRecommendedBackend).not.toHaveBeenCalled()
      })

      it('keeps the working backend when the pinned download fails', async () => {
        const current = 'b9937/win-vulkan-x64'
        extension['config'] = { version_backend: current } as any
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockRejectedValue(new Error('asset unavailable'))

        await expect(
          extension['enforcePinnedBackendVersion']()
        ).resolves.toBeUndefined()
        expect(extension['config'].version_backend).toBe(current)
      })
    })

    describe('version update', () => {
      it('bumps the version and keeps the backend type', async () => {
        await stubUpdateBackendDeps('win-cuda-13.3-x64')
        extension['config'] = {
          version_backend: 'b9800/win-cuda-13.3-x64',
          device: '',
        } as any

        const result = await extension.updateBackend(RECOMMENDED)

        expect(result).toEqual({ wasUpdated: true, newBackend: RECOMMENDED })
        expect(extension['ensureBackendReady']).toHaveBeenCalledWith(
          'win-cuda-13.3-x64',
          'b10205'
        )
        expect(persistedVersionBackend()).toBe(RECOMMENDED)
        expect(extension['config'].version_backend).toBe(RECOMMENDED)
        // The type is unchanged, so the stored preference must be left alone.
        expect(extension['setStoredBackendType']).not.toHaveBeenCalled()
      })

      it('records the new type when the update also switches tier', async () => {
        await stubUpdateBackendDeps('win-cpu-x64')

        await extension.updateBackend(RECOMMENDED)

        expect(persistedVersionBackend()).toBe(RECOMMENDED)
        expect(extension['setStoredBackendType']).toHaveBeenCalledWith(
          'win-cuda-13.3-x64'
        )
      })

      it('offers the freshly installed version as a dropdown option', async () => {
        await stubUpdateBackendDeps('win-cuda-13.3-x64')

        await extension.updateBackend(RECOMMENDED)

        expect(extension['ensureBackendOption']).toHaveBeenCalledWith(
          RECOMMENDED
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
        expect(localStorage.removeItem).toHaveBeenCalledWith(
          'llama_cpp_pending_backend'
        )

        const event = vi.mocked((window as any).dispatchEvent).mock
          .calls[0][0] as CustomEvent
        expect(event.type).toBe('app:backend-hotswapped')
        // The detail names its provider so the turboquant popup ignores this
        // swap instead of completing on it.
        expect(event.detail).toEqual({
          backend: RECOMMENDED,
          provider: 'llamacpp-upstream',
          version: 'b10205',
          backendId: 'win-cuda-13.3-x64',
        })
      })

      it('keeps loaded models alive when the swap cannot be persisted', async () => {
        extension['getLoadedModels'] = vi.fn().mockResolvedValue(['m1'])
        extension.updateBackend = vi.fn().mockResolvedValue({
          wasUpdated: false,
          newBackend: 'b9800/win-cpu-x64',
        })
        extension.unload = vi.fn()

        await expect(
          extension['applyBackendLive'](RECOMMENDED)
        ).rejects.toThrow(/wasUpdated=false/)

        expect(extension.unload).not.toHaveBeenCalled()
        expect(localStorage.removeItem).not.toHaveBeenCalledWith(
          'llama_cpp_pending_backend'
        )
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
          'pending:llama_cpp_pending_backend',
          'download',
          `apply:${RECOMMENDED}`,
        ])
        expect(localStorage.removeItem).toHaveBeenCalledWith(
          'llama_cpp_better_backend_recommendation'
        )
      })

      it('drops the pending marker when the download fails', async () => {
        extension['downloadAndInstallBackend'] = vi
          .fn()
          .mockRejectedValue(new Error('asset 404'))
        extension['applyBackendLive'] = vi.fn()

        await expect(
          extension.downloadRecommendedBackend(RECOMMENDED)
        ).rejects.toThrow('asset 404')

        expect(localStorage.removeItem).toHaveBeenCalledWith(
          'llama_cpp_pending_backend'
        )
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

        expect(localStorage.removeItem).not.toHaveBeenCalledWith(
          'llama_cpp_pending_backend'
        )
      })
    })

    describe('activatePendingBackend', () => {
      beforeEach(() => {
        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === 'llama_cpp_pending_backend' ? RECOMMENDED : null
        )
      })

      it('activates a backend downloaded before the last restart', async () => {
        vi.mocked(isBackendInstalled).mockResolvedValue(true)
        extension.updateBackend = vi
          .fn()
          .mockResolvedValue({ wasUpdated: true, newBackend: RECOMMENDED })

        await extension['activatePendingBackend']()

        expect(extension.updateBackend).toHaveBeenCalledWith(RECOMMENDED)
        expect(localStorage.removeItem).toHaveBeenCalledWith(
          'llama_cpp_pending_backend'
        )
      })

      it('clears a pending backend that never made it to disk', async () => {
        vi.mocked(isBackendInstalled).mockResolvedValue(false)
        extension.updateBackend = vi.fn()

        await extension['activatePendingBackend']()

        expect(extension.updateBackend).not.toHaveBeenCalled()
        expect(localStorage.removeItem).toHaveBeenCalledWith(
          'llama_cpp_pending_backend'
        )
      })
    })

    describe('recheckOptimalBackend', () => {
      // The guest-js bridge is mocked with `importActual`, so its own
      // `@tauri-apps/api/core` import is the real one — the release lookup has
      // to be stubbed at the Tauri bridge, as in the ATO-153 test above.
      const stubLatestLookup = (latest: string | null) => {
        ;(window as any).__TAURI_INTERNALS__ = {
          invoke: vi.fn(async (cmd: string) =>
            cmd.endsWith('find_latest_version_for_backend') ? latest : undefined
          ),
        }
      }

      afterEach(() => {
        delete (window as any).__TAURI_INTERNALS__
      })

      it('recommends the newest release of the detected GPU tier', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'win-cuda-13.3-x64',
        })
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'b9800', backend: 'win-cuda-13.3-x64', order: 0 },
          { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
        ])
        stubLatestLookup(RECOMMENDED)

        const result = await extension.recheckOptimalBackend()

        expect(result).toMatchObject({
          currentBackend: 'b9800/win-cpu-x64',
          recommendedBackend: RECOMMENDED,
        })
        expect(localStorage.setItem).toHaveBeenCalledWith(
          'llama_cpp_better_backend_recommendation',
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
          backend: 'win-cuda-13.3-x64',
        })

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(localStorage.removeItem).toHaveBeenCalledWith(
          'llama_cpp_better_backend_recommendation'
        )
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_BACKEND_CACHE_KEY,
          expect.any(String)
        )
        expect(localStorage.setItem).not.toHaveBeenCalledWith(
          'llama_cpp_better_backend_recommendation',
          expect.anything()
        )
      })

      it('returns nothing when CPU genuinely is the best this host can do', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'cpu-optimal',
        })

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_BACKEND_CACHE_KEY,
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
      const stubLatestLookup = (latest: string | null) => {
        ;(window as any).__TAURI_INTERNALS__ = {
          invoke: vi.fn(async (cmd: string) =>
            cmd.endsWith('find_latest_version_for_backend') ? latest : undefined
          ),
        }
      }

      afterEach(() => {
        delete (window as any).__TAURI_INTERNALS__
      })

      it('caches a resolved GPU result without recommendation side effects', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_777_777_777_777)
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'win-cuda-13.3-x64',
        })
        vi.mocked(listSupportedBackends).mockResolvedValue([
          { version: 'b10205', backend: 'win-cuda-13.3-x64', order: 0 },
        ])
        stubLatestLookup(RECOMMENDED)

        const result = await extension.refreshOptimalBackendCache()

        expect(result).toEqual({
          schemaVersion: 1,
          provider: 'llamacpp-upstream',
          detectedAt: 1_777_777_777_777,
          detectionKind: 'gpu',
          currentBackend: 'b9800/win-cpu-x64',
          idealBackendId: 'win-cuda-13.3-x64',
          recommendedBackend: RECOMMENDED,
          recommendedCategory: 'CUDA 13',
        })
        expect(localStorage.setItem).toHaveBeenCalledTimes(1)
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_BACKEND_CACHE_KEY,
          JSON.stringify(result)
        )
        expect(localStorage.removeItem).not.toHaveBeenCalled()

        const { events, AppEvent } = await import('@janhq/core')
        expect(events.emit).not.toHaveBeenCalledWith(
          AppEvent.onBetterBackendDetected,
          expect.anything()
        )
      })

      it('caches a CPU-optimal result', async () => {
        vi.spyOn(Date, 'now').mockReturnValue(1_888_888_888_888)
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'cpu-optimal',
        })

        const result = await extension.refreshOptimalBackendCache()

        expect(result).toEqual({
          schemaVersion: 1,
          provider: 'llamacpp-upstream',
          detectedAt: 1_888_888_888_888,
          detectionKind: 'cpu-optimal',
          currentBackend: 'b9800/win-cpu-x64',
          recommendedCategory: 'CPU',
        })
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_BACKEND_CACHE_KEY,
          JSON.stringify(result)
        )
        expect(listSupportedBackends).not.toHaveBeenCalled()
      })

      it('uses the confirmed CPU-only fast path without hardware detection', async () => {
        const detect = vi.spyOn(extension as any, 'detectIdealBackendType')

        const result = await extension.refreshOptimalBackendCache({
          hardwareHasNoGpu: true,
        })

        expect(result?.detectionKind).toBe('cpu-optimal')
        expect(detect).not.toHaveBeenCalled()
        expect(listSupportedBackends).not.toHaveBeenCalled()
      })

      it('preserves a successful cache when detection fails', async () => {
        const previous = {
          schemaVersion: 1,
          provider: 'llamacpp-upstream',
          detectedAt: 1_700_000_000_000,
          detectionKind: 'cpu-optimal',
          currentBackend: 'b9800/win-cpu-x64',
          recommendedCategory: 'CPU',
        }
        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === OPTIMAL_BACKEND_CACHE_KEY ? JSON.stringify(previous) : null
        )
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'detection-failed',
        })

        await expect(extension.refreshOptimalBackendCache()).rejects.toThrow(
          BACKEND_DETECTION_FAILED
        )

        expect(localStorage.setItem).not.toHaveBeenCalled()
        expect(localStorage.removeItem).not.toHaveBeenCalled()
        expect(extension.getCachedOptimalBackend()).toEqual(previous)
      })

      it('returns only validated cached records', () => {
        vi.mocked(localStorage.getItem).mockReturnValue(
          JSON.stringify({
            schemaVersion: 1,
            provider: 'llamacpp-upstream',
            detectedAt: 1_700_000_000_000,
            detectionKind: 'gpu',
            currentBackend: 'b9800/win-cpu-x64',
            idealBackendId: 'win-cuda-13.3-x64',
            recommendedBackend: 'latest/win-cuda-13.3-x64',
            recommendedCategory: 'CUDA 13',
          })
        )

        expect(extension.getCachedOptimalBackend()).toBeNull()
      })

      it('prefers cached GPU idealBackendId then falls back to the legacy key', () => {
        const cached = {
          schemaVersion: 1,
          provider: 'llamacpp-upstream',
          detectedAt: 1_700_000_000_000,
          detectionKind: 'gpu',
          currentBackend: 'b9800/win-cpu-x64',
          idealBackendId: 'win-cuda-13.3-x64',
          recommendedBackend: RECOMMENDED,
          recommendedCategory: 'CUDA 13',
        }
        vi.mocked(localStorage.getItem).mockImplementation((key: string) => {
          if (key === OPTIMAL_BACKEND_CACHE_KEY) return JSON.stringify(cached)
          if (key === 'llama_cpp_better_backend_recommendation') {
            return JSON.stringify({
              recommendedBackend: 'b10205/win-vulkan-x64',
            })
          }
          return null
        })

        expect(extension['storedRecommendedBackendType']()).toBe(
          'win-cuda-13.3-x64'
        )

        vi.mocked(localStorage.getItem).mockImplementation((key: string) =>
          key === 'llama_cpp_better_backend_recommendation'
            ? JSON.stringify({
                recommendedBackend: 'b10205/win-vulkan-x64',
              })
            : null
        )
        expect(extension['storedRecommendedBackendType']()).toBe(
          'win-vulkan-x64'
        )
      })
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
