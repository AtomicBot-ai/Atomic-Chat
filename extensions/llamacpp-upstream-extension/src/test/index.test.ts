import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import llamacpp_extension, {
  BACKEND_DETECTION_FAILED,
  OPTIMAL_BACKEND_CACHE_KEY,
} from '../index'

import {
  getSupportedFeaturesFromRust,
  mapOldBackendToNew,
  readGgufMetadata,
  removeOldBackendVersions,
} from '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
import {
  getBackendDir,
  getLocalInstalledBackends,
  isBackendInstalled,
  listSupportedBackends,
} from '../backend'
import { getSystemInfo } from '../hardware'
import { events, fs, joinPath } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { basename } from '@tauri-apps/api/path'

// Mock fetch globally
global.fetch = vi.fn()

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

// Mock backend functions
vi.mock('../backend', async () => {
  // Pure helpers the tested logic reasons *with* rather than *about*: the
  // family predicate the release-tag reconciliation depends on, and the option
  // assembly `configureBackends` builds its dropdown from. Stubbing these would
  // make the tests assert against a mock instead of the real rules.
  const { isConcreteOfGpuFamily, friendlyBackendLabel, mergeBackendOptions } =
    await vi.importActual<typeof import('../backend')>('../backend')

  return {
    isBackendInstalled: vi.fn(),
    getBackendExePath: vi.fn(),
    listSupportedBackends: vi.fn(),
    getBackendDir: vi.fn(),
    getLocalInstalledBackends: vi.fn(),
    isConcreteOfGpuFamily,
    friendlyBackendLabel,
    mergeBackendOptions,
  }
})

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
      mapOldBackendToNew: vi.fn(),
      readGgufMetadata: vi.fn(),
      removeOldBackendVersions: vi.fn(),
    }
  }
)

describe('llamacpp_extension', () => {
  let extension: llamacpp_extension

  beforeEach(() => {
    vi.clearAllMocks()
    vi.mocked(invoke).mockImplementation(async () => undefined)
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

  describe('backend download', () => {
    it('subscribes before install and completes the existing UI event sequence', async () => {
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(localStorage.getItem).mockReturnValue(null)
      const unlisten = vi.fn()
      let progress: ((event: { payload: { transferred: number; total: number } }) => void) | undefined
      vi.mocked(listen).mockImplementation(async (_name, callback) => {
        progress = callback as typeof progress
        return unlisten
      })
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_call') {
          expect(progress, 'listener exists before POST begins').toBeDefined()
          progress?.({ payload: { transferred: 10, total: 20 } })
          progress?.({ payload: { transferred: 5, total: 20 } })
          progress?.({ payload: { transferred: 20, total: 20 } })
          return { installed: true, version: 'b1', backend: 'macos-arm64', path: '/pack' }
        }
        return undefined
      })
      await extension['downloadAndInstallBackend']('b1/macos-arm64')
      const emitted = vi.mocked(events.emit).mock.calls.map(([name]) => name)
      expect(emitted).toEqual([
        'onBackendDownloadStarted', 'onFileDownloadUpdate', 'onFileDownloadUpdate', 'onFileDownloadUpdate',
        'onFileDownloadAndVerificationSuccess', 'onBackendDownloadFinished',
      ])
      expect(vi.mocked(events.emit).mock.calls.filter(([name]) => name === 'onFileDownloadUpdate').map(([, payload]) => (payload as { size: { transferred: number } }).size.transferred)).toEqual([10, 10, 20])
      expect(unlisten).toHaveBeenCalledOnce()
      expect(vi.mocked(listen).mock.calls[0]?.[0]).toBe('download-llamacpp-backend-b1/macos-arm64')
    })

    it('closes the progress row and reports failure when the core install rejects', async () => {
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(localStorage.getItem).mockReturnValue(null)
      const unlisten = vi.fn()
      vi.mocked(listen).mockResolvedValue(unlisten)
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_call') throw new Error('cancelled')
        return undefined
      })
      await expect(extension['downloadAndInstallBackend']('b1/macos-arm64')).rejects.toThrow('cancelled')
      expect(vi.mocked(events.emit).mock.calls.map(([name]) => name)).toEqual([
        'onBackendDownloadStarted', 'onFileDownloadError', 'onBackendDownloadFinished',
      ])
      expect(unlisten).toHaveBeenCalledOnce()
    })

    it('routes a relayed stage frame to the row status, not the progress bar', async () => {
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(localStorage.getItem).mockReturnValue(null)
      type Frame = { transferred: number; total: number; stage?: { kind: string; attempt: number; maxAttempts: number } }
      let progress: ((event: { payload: Frame }) => void) | undefined
      vi.mocked(listen).mockImplementation(async (_name, callback) => {
        progress = callback as typeof progress
        return vi.fn()
      })
      const stage = { kind: 'retrying', attempt: 2, maxAttempts: 5 }
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_call') {
          progress?.({ payload: { transferred: 10, total: 20 } })
          // What the relay makes of the core's `download:stage`: the same name, counters at zero.
          progress?.({ payload: { transferred: 0, total: 0, stage } })
          progress?.({ payload: { transferred: 15, total: 20 } })
          return { installed: true, version: 'b1', backend: 'macos-arm64', path: '/pack' }
        }
        return undefined
      })
      await extension['downloadAndInstallBackend']('b1/macos-arm64')
      const taskId = 'llamacpp-backend-b1/macos-arm64'
      const updates = vi.mocked(events.emit).mock.calls
        .filter(([name]) => name === 'onFileDownloadUpdate')
        .map(([, payload]) => payload)
      expect(updates).toEqual([
        { modelId: taskId, percent: 0.5, size: { transferred: 10, total: 20 }, downloadType: 'Backend' },
        { modelId: taskId, downloadType: 'Backend', stage },
        { modelId: taskId, percent: 0.75, size: { transferred: 15, total: 20 }, downloadType: 'Backend' },
        // The missing last frame is still made up at the end; the stage frame did not count as one.
        { modelId: taskId, percent: 1, size: { transferred: 20, total: 20 }, downloadType: 'Backend' },
      ])
    })

    it('names the row after the task id when a stage frame comes before any byte', async () => {
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(localStorage.getItem).mockReturnValue(null)
      type Frame = { transferred: number; total: number; stage?: { kind: string; attempt: number; maxAttempts: number } }
      let progress: ((event: { payload: Frame }) => void) | undefined
      vi.mocked(listen).mockImplementation(async (_name, callback) => {
        progress = callback as typeof progress
        return vi.fn()
      })
      // The core's order: the preflight's stages, then the bytes.
      const connecting = { kind: 'connecting', attempt: 0, maxAttempts: 6 }
      const retrying = { kind: 'retrying', attempt: 1, maxAttempts: 6 }
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_call') {
          progress?.({ payload: { transferred: 0, total: 0, stage: connecting } })
          progress?.({ payload: { transferred: 0, total: 0, stage: retrying } })
          progress?.({ payload: { transferred: 10, total: 20 } })
          return { installed: true, version: 'b1', backend: 'macos-arm64', path: '/pack' }
        }
        return undefined
      })
      await extension['downloadAndInstallBackend']('b1/macos-arm64')
      const taskId = 'llamacpp-backend-b1/macos-arm64'
      const updates = vi.mocked(events.emit).mock.calls
        .filter(([name]) => name === 'onFileDownloadUpdate')
        .map(([, payload]) => payload)
      expect(updates).toEqual([
        // A progress update names the row (a stage update would leave it blank, and its Cancel
        // would not reach the core task), once.
        { modelId: taskId, percent: 0, size: { transferred: 0, total: 0 }, downloadType: 'Backend' },
        { modelId: taskId, downloadType: 'Backend', stage: connecting },
        { modelId: taskId, downloadType: 'Backend', stage: retrying },
        { modelId: taskId, percent: 0.5, size: { transferred: 10, total: 20 }, downloadType: 'Backend' },
        // The seed changes nothing at the end: the missing last frame is still made up.
        { modelId: taskId, percent: 1, size: { transferred: 20, total: 20 }, downloadType: 'Backend' },
      ])
    })

    it('finishes the existing progress bar even if the last core progress frame is missing', async () => {
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(localStorage.getItem).mockReturnValue(null)
      let progress: ((event: { payload: { transferred: number; total: number } }) => void) | undefined
      vi.mocked(listen).mockImplementation(async (_name, callback) => {
        progress = callback as typeof progress
        return vi.fn()
      })
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_call') progress?.({ payload: { transferred: 10, total: 20 } })
        return { installed: true, version: 'b1', backend: 'macos-arm64', path: '/pack' }
      })
      await extension['downloadAndInstallBackend']('b1/macos-arm64')
      expect(vi.mocked(events.emit).mock.calls.filter(([name]) => name === 'onFileDownloadUpdate').map(([, payload]) => (payload as { size: { transferred: number; total: number } }).size)).toEqual([
        { transferred: 10, total: 20 }, { transferred: 20, total: 20 },
      ])
    })
  })

  describe('optimal cache and embeddings', () => {
    const optimal = {
      schemaVersion: 1, provider: 'llamacpp-upstream', detectedAt: 1,
      detectionKind: 'cpu-optimal', currentBackend: 'b1/macos-arm64', recommendedCategory: 'CPU',
    }

    it('adopts the snapshot before reading the synchronous UI copy', async () => {
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_snapshot') return { snapshot: { optimal_backends: { 'llamacpp-upstream': { revision: 3, optimal } } } }
        return undefined
      })
      await extension['adoptOptimalFromCore']()
      expect(localStorage.setItem).toHaveBeenCalledWith(OPTIMAL_BACKEND_CACHE_KEY, JSON.stringify(optimal))
      expect(extension['optimalRevision']).toBe(3)
    })

    it('does not restore an old snapshot after the attachment generation changes', async () => {
      let releaseSnapshot!: (value: unknown) => void
      const snapshot = new Promise((resolve) => { releaseSnapshot = resolve })
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'atomic_core_snapshot') return snapshot
        return undefined
      })
      const pending = extension['adoptOptimalFromCore']()
      await vi.waitFor(() => expect(invoke).toHaveBeenCalledWith('atomic_core_snapshot'))
      extension['optimalEpoch']++
      releaseSnapshot({ snapshot: { optimal_backends: { 'llamacpp-upstream': { revision: 3, optimal } } } })
      await pending
      expect(localStorage.setItem).not.toHaveBeenCalled()
      expect(extension['optimalRevision']).toBe(0)
    })

    it('does not show a new detection before the core accepts its revision', async () => {
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'atomic_core_call' && (args as { method?: string }).method === 'PUT') {
          expect(localStorage.setItem).not.toHaveBeenCalled()
          return { status: 'updated', current: { revision: 1, optimal } }
        }
        return undefined
      })
      await extension['storeOptimalRecord'](optimal as never)
      expect(localStorage.setItem).toHaveBeenCalledWith(OPTIMAL_BACKEND_CACHE_KEY, JSON.stringify(optimal))
    })

    it('delegates embeddings to the core, which owns the embedding session', async () => {
      extension.list = vi.fn().mockResolvedValue([{ id: 'sentence-transformer-mini' }])
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      extension['config'] = { ubatch_size: 64 } as never
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'atomic_core_call') {
          expect(args).toMatchObject({ method: 'POST', path: '/models/llamacpp-upstream/sentence-transformer-mini/embed', body: { input: ['hello'], ubatch_size: 64 } })
          return { model: 'sentence-transformer-mini', object: 'list', data: [{ embedding: [1], index: 0 }], usage: { prompt_tokens: 1, total_tokens: 1 } }
        }
        return undefined
      })
      expect((await extension.embed(['hello'])).data).toHaveLength(1)
      // No session lookup and no model load of its own: the embed route is the whole exchange.
      expect(vi.mocked(invoke).mock.calls.map(([command]) => command)).toEqual(['atomic_core_call'])
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

    /// The Windows counterpart of the Linux case above: here ggml-org *does*
    /// publish a HIP archive, so a ROCm-capable AMD card outranks Vulkan.
    it('prefers ROCm over Vulkan on a ROCm-capable AMD Windows host', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
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
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10405', backend: 'win-cpu-x64', order: 0 },
        { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 0 },
        { version: 'b10405', backend: 'win-vulkan-x64', order: 0 },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-rocm-7.14-x64',
      })
    })

    /// An AMD card the generated PCI table does not cover: the Rust gate
    /// reports `rocm: false` and the host must land on Vulkan, not on a HIP
    /// build compiled for a different gfx target.
    it('falls back to Vulkan when the AMD card is outside the ROCm table', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [{ ...discreteGpu, vendor: 'AMD', nvidia_info: undefined }],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: false,
        cuda13: false,
        rocm: false,
        vulkan: true,
      } as any)
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10405', backend: 'win-cpu-x64', order: 0 },
        { version: 'b10405', backend: 'win-rocm-7.14-x64', order: 0 },
        { version: 'b10405', backend: 'win-vulkan-x64', order: 0 },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-vulkan-x64',
      })
    })

    it('offers Vulkan to an integrated-only Linux host the loader can see', async () => {
      // Linux installs on the CPU build; Vulkan is the only GPU build it can
      // move to, and a capable iGPU beats the CPU fallback. The discrete-card
      // requirement kept such hosts on CPU for good (ATO-464).
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
        kind: 'gpu',
        backend: 'linux-vulkan-x64',
      })
    })

    it('offers Vulkan to a small Linux card the 6 GiB bar used to exclude', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 16 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [{ ...discreteGpu, total_memory: 4 * 1024 }],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: true,
      })

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'linux-vulkan-x64',
      })
    })

    it('asks again later when a Linux GPU is present but the Vulkan loader is not', async () => {
      // libvulkan1 missing on a fresh install: not a verdict, and the old
      // `cpu-optimal` answer was cached as one, so nothing ever re-checked.
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
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

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'detection-failed',
      })
    })

    it('keeps a Linux host with no accelerator at all on CPU', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'linux',
        os_name: 'Linux',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: false,
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

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-vulkan-x64',
      })
    })

    // ATO-464 lowered the GPU bar to 2 GiB on Linux only, leaving Windows on
    // an inline 6 GiB that gated Vulkan and ROCm but never CUDA. A 4 GB
    // Radeon was told "CPU is optimal" — and cached — while a 4 GB GeForce
    // on the same path got CUDA.
    it('offers Vulkan to a small Windows AMD card the 6 GiB bar used to exclude', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [
          {
            name: 'AMD Radeon RX 6500 XT',
            vendor: 'AMD',
            total_memory: 4 * 1024,
            uuid: 'dgpu-amd-small',
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

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-vulkan-x64',
      })
    })

    it('offers ROCm to a small Windows AMD card the table already covers', async () => {
      vi.mocked(getSystemInfo).mockResolvedValue({
        os_type: 'windows',
        os_name: 'Windows',
        total_memory: 32 * 1024,
        cpu: { arch: 'x86_64', extensions: [] },
        gpus: [
          {
            name: 'AMD Radeon RX 7600',
            vendor: 'AMD',
            total_memory: 4 * 1024,
            uuid: 'dgpu-amd-rocm',
            driver_version: 'fixture',
            nvidia_info: undefined,
            vulkan_info: { device_type: 'DiscreteGpu', device_id: 0x7480 },
          },
        ],
      } as any)
      vi.mocked(getSupportedFeaturesFromRust).mockResolvedValue({
        cuda11: false,
        cuda12: false,
        cuda13: false,
        vulkan: true,
        rocm: true,
      })
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10205', backend: 'win-cpu-x64', order: 0 },
        { version: 'b10205', backend: 'win-rocm-7.14-x64', order: 0 },
        { version: 'b10205', backend: 'win-vulkan-x64', order: 0 },
      ])

      await expect(extension['detectIdealBackendType']()).resolves.toEqual({
        kind: 'gpu',
        backend: 'win-rocm-7.14-x64',
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
    it('downloads every shard of a multi-part model, under its published name', async () => {
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
      // The catalog folds a sharded quant into one entry pointing at shard 1;
      // fetching only that file leaves a model that can never load.
      await extension.import('sharded-model', {
        modelPath:
          'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00001-of-00003.gguf',
      })

      const [items] = mockDownloadManager.downloadFiles.mock.calls[0]
      expect(items.map((i: { url: string }) => i.url)).toEqual([
        'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00001-of-00003.gguf',
        'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00002-of-00003.gguf',
        'https://huggingface.co/unsloth/M-GGUF/resolve/main/BF16/M-BF16-00003-of-00003.gguf',
      ])
      // Saved under the published names so llama.cpp finds the siblings.
      expect(items.map((i: { save_path: string }) => i.save_path)).toEqual([
        'llamacpp/models/sharded-model/M-BF16-00001-of-00003.gguf',
        'llamacpp/models/sharded-model/M-BF16-00002-of-00003.gguf',
        'llamacpp/models/sharded-model/M-BF16-00003-of-00003.gguf',
      ])

      const written = vi
        .mocked(invoke)
        .mock.calls.find(([cmd]) => cmd === 'write_yaml')?.[1] as {
        data: Record<string, unknown>
      }
      expect(written.data.model_path).toBe(
        'llamacpp/models/sharded-model/M-BF16-00001-of-00003.gguf'
      )
      // Whole set, not the header-sized first shard.
      expect(written.data.size_bytes).toBe(3000000)
      // Per-file expectations would describe the download, not shard 1.
      expect(written.data.model_size_bytes).toBeUndefined()
    })

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
    it('loads through the core with the per-model overrides once the core is ready', async () => {
      const order: string[] = []
      extension['ensureCoreIsReady'] = vi.fn(async () => {
        order.push('ready')
      })
      const session = {
        model_id: 'test-model',
        pid: 123,
        port: 3000,
        api_key: 'test-api-key',
      }
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        order.push(command)
        if (command === 'atomic_core_call') return { session, created: true }
        return undefined
      })

      const result = await extension.load(
        'org/test-model',
        { ctx_size: 4096 } as any,
        false,
        true
      )

      expect(result).toEqual(session)
      // Settings reach the core before the model does: a load that raced the import would use the
      // core's defaults instead of the user's.
      expect(order).toEqual(['ready', 'atomic_core_call'])
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/llamacpp-upstream/org/test-model/load',
        body: {
          overrides: { ctx_size: 4096 },
          isEmbedding: false,
          bypassAutoUnload: true,
        },
      })
    })

    it('reports a core refusal as a readable error that keeps its code', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      vi.mocked(invoke).mockRejectedValue({
        code: 'MODEL_FILE_NOT_FOUND',
        message: 'The specified model file does not exist',
        details: '/models/m.gguf',
      })

      await expect(extension.load('m')).rejects.toThrow(
        'The specified model file does not exist (/models/m.gguf) [MODEL_FILE_NOT_FOUND]'
      )
    })

    it('does not load when the core is not ready for it', async () => {
      extension['ensureCoreIsReady'] = vi
        .fn()
        .mockRejectedValue(new Error('Atomic core settings conflict: ctx_size'))

      await expect(extension.load('m')).rejects.toThrow('settings conflict')
      expect(invoke).not.toHaveBeenCalledWith('atomic_core_call', expect.anything())
    })

    it('keeps the code on the error, so the web app can tell a cancel from a failure', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      vi.mocked(invoke).mockRejectedValue({
        code: 'MODEL_LOAD_CANCELLED',
        message: 'The model load was cancelled.',
      })
      await expect(extension.load('m')).rejects.toMatchObject({
        code: 'MODEL_LOAD_CANCELLED',
        message: 'The model load was cancelled. [MODEL_LOAD_CANCELLED]',
      })
    })

    it('names the stages a watching caller waits on, with the page-cache fraction', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      extension['isConfiguredBackendInstalled'] = vi.fn(async () => false)
      extension['modelFilePaths'] = vi.fn(async () => ['/data/llamacpp/models/m/model.gguf'])
      const session = { model_id: 'm', pid: 1, port: 2, api_key: 'k' }
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command === 'get_page_cache_resident_fraction') {
          expect(args).toEqual({ paths: ['/data/llamacpp/models/m/model.gguf'] })
          return 0.25
        }
        if (command === 'atomic_core_call') return { session, created: true }
        return undefined
      })
      const stages: unknown[] = []
      await extension.load('m', undefined, false, false, { onStage: (stage) => stages.push(stage) })
      expect(stages).toEqual([
        { kind: 'installingEngine' },
        { kind: 'loadingWeights', cachedFraction: 0.25 },
      ])

      // An installed engine has no install stage; an unreadable cache is `null`, never a failure.
      stages.length = 0
      extension['isConfiguredBackendInstalled'] = vi.fn(async () => true)
      vi.mocked(invoke).mockImplementation(async (command) => {
        if (command === 'get_page_cache_resident_fraction') throw new Error('no probe')
        if (command === 'atomic_core_call') return { session, created: true }
        return undefined
      })
      await extension.load('m', undefined, false, false, { onStage: (stage) => stages.push(stage) })
      expect(stages).toEqual([{ kind: 'loadingWeights', cachedFraction: null }])
    })

    it('cancels a load in flight through the core, and the load rejects as cancelled', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      let rejectLoad!: (error: unknown) => void
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        const { path } = args as { path: string }
        if (command === 'atomic_core_call' && path.endsWith('/load/cancel')) {
          rejectLoad({ code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' })
          return { cancelled: true }
        }
        if (command === 'atomic_core_call' && path.endsWith('/load'))
          return new Promise((_, reject) => (rejectLoad = reject))
        return undefined
      })
      expect(await extension.cancelLoad('m')).toBe(false)
      const load = extension.load('m')
      load.catch(() => {}) // the rejection lands before the assertion below attaches its handler
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await extension.cancelLoad('m')).toBe(true)
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/llamacpp-upstream/m/load/cancel',
        body: null,
      })
      await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
      expect(await extension.cancelLoad('m')).toBe(false)
    })

    it('unloads a session that came up before the cancel reached the core', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      const session = { model_id: 'm', pid: 1, port: 2, api_key: 'k' }
      let resolveLoad!: (value: unknown) => void
      const unloads: string[] = []
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        const { path } = args as { path: string }
        if (command !== 'atomic_core_call') return undefined
        if (path.endsWith('/load/cancel')) return { cancelled: false }
        if (path.endsWith('/unload')) {
          unloads.push(path)
          return { success: true }
        }
        if (path.endsWith('/load')) return new Promise((resolve) => (resolveLoad = resolve))
        return undefined
      })
      const load = extension.load('m')
      load.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 0))
      const cancelling = extension.cancelLoad('m')
      await new Promise((resolve) => setTimeout(resolve, 5))
      resolveLoad({ session, created: true })
      expect(await cancelling).toBe(true)
      await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
      expect(unloads).toEqual(['/models/llamacpp-upstream/m/unload'])
    })
  })

  describe('unload', () => {
    it('asks the core to unload and returns its answer', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true })

      await expect(extension.unload('org/test-model')).resolves.toEqual({
        success: true,
      })
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/llamacpp-upstream/org/test-model/unload',
        body: null,
      })
    })

    it('turns a core failure into an unsuccessful result instead of throwing', async () => {
      vi.mocked(invoke).mockRejectedValue({
        code: 'CORE_NOT_RUNNING',
        message: 'core is gone',
      })

      await expect(extension.unload('m')).resolves.toEqual({
        success: false,
        error: 'Failed to unload model: core is gone [CORE_NOT_RUNNING]',
      })
    })
  })

  describe('chat', () => {
    const coreSession = {
      model_id: 'test-model',
      pid: 123,
      port: 3000,
      api_key: 'test-key',
      provider: 'llamacpp-upstream',
    }

    it('should throw error if no active session found', async () => {
      vi.mocked(invoke).mockResolvedValue({ sessions: [] })
      const request = {
        model: 'nonexistent-model',
        messages: [{ role: 'user', content: 'Hello' }],
      }

      await expect(extension.chat(request)).rejects.toThrow(
        'No active session found'
      )
    })

    it('sends a non-streaming request to the port the core reports', async () => {
      vi.mocked(invoke).mockImplementation(async (command, args) =>
        command === 'atomic_core_call' &&
        (args as { path?: string }).path === '/sessions'
          ? { sessions: [coreSession] }
          : undefined
      )

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
      expect(fetch).toHaveBeenCalledWith('http://localhost:3000/health')
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
      // Liveness is the port answering; the core's pid is not in any table this process can ask.
      expect(
        vi.mocked(invoke).mock.calls.every(([command]) => command === 'atomic_core_call')
      ).toBe(true)
    })

    it('unloads a model whose server no longer answers and says so', async () => {
      vi.mocked(invoke).mockImplementation(async (command, args) =>
        command === 'atomic_core_call' &&
        (args as { path?: string }).path === '/sessions'
          ? { sessions: [coreSession] }
          : { success: true }
      )
      global.fetch = vi.fn().mockRejectedValue(new Error('connection refused'))

      await expect(
        extension.chat({
          model: 'test-model',
          messages: [{ role: 'user', content: 'Hello' }],
        } as any)
      ).rejects.toThrow('Model appears to have crashed')
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/llamacpp-upstream/test-model/unload',
        body: null,
      })
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

  describe('migrateFitDefaultOn', () => {
    const FORCED_OFF_KEY = 'llamacpp_fit_disabled_v1'
    const MIGRATION_KEY = 'llamacpp_fit_enabled_v2'
    const storage = (values: Record<string, string>) =>
      vi
        .mocked(localStorage.getItem)
        .mockImplementation((key: string) => values[key] ?? null)

    beforeEach(() => {
      storage({})
    })

    it('runs once', async () => {
      storage({ [MIGRATION_KEY]: '1', [FORCED_OFF_KEY]: '1' })
      extension['config'] = { fit: false } as any
      extension['getSettings'] = vi.fn()

      await extension['migrateFitDefaultOn']()

      expect(extension['getSettings']).not.toHaveBeenCalled()
    })

    it('leaves a profile alone that the old migration never touched', async () => {
      extension['config'] = { fit: false } as any
      extension['getSettings'] = vi.fn()
      extension['updateSettings'] = vi.fn()

      await extension['migrateFitDefaultOn']()

      expect(extension['updateSettings']).not.toHaveBeenCalled()
      expect(extension['config'].fit).toBe(false)
      expect(localStorage.setItem).toHaveBeenCalledWith(MIGRATION_KEY, '1')
    })

    it('re-enables fit where the old migration forced it off', async () => {
      // Nobody chose `false` on such a profile: the v1 migration wrote it for
      // everyone. Fit is the default again, so the profile follows.
      storage({ [FORCED_OFF_KEY]: '1' })
      extension['config'] = { fit: false, fit_ctx: 4096, fit_target: '1024' } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'fit', controllerProps: { value: false } },
        { key: 'ctx_size', controllerProps: { value: 2048 } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateFitDefaultOn']()

      const updated = vi.mocked(extension['updateSettings']).mock.calls[0][0]
      expect(updated.find((s: any) => s.key === 'fit').controllerProps.value).toBe(
        true
      )
      expect(
        updated.find((s: any) => s.key === 'ctx_size').controllerProps.value
      ).toBe(2048)
      expect(extension['config'].fit).toBe(true)
      expect(localStorage.removeItem).toHaveBeenCalledWith(FORCED_OFF_KEY)
      expect(localStorage.setItem).toHaveBeenCalledWith(MIGRATION_KEY, '1')
    })

    it('respects a user who configured fit themselves', async () => {
      // A non-default floor or target says fit was set up on purpose; their
      // `false` is a choice, not the old migration's leftover.
      storage({ [FORCED_OFF_KEY]: '1' })
      extension['config'] = { fit: false, fit_ctx: 8192, fit_target: '1024' } as any
      extension['getSettings'] = vi.fn()
      extension['updateSettings'] = vi.fn()

      await extension['migrateFitDefaultOn']()

      expect(extension['updateSettings']).not.toHaveBeenCalled()
      expect(extension['config'].fit).toBe(false)
      expect(localStorage.setItem).toHaveBeenCalledWith(MIGRATION_KEY, '1')
    })
  })
  describe('getRuntimeDeviceInfo', () => {
    it('reads the device from the session the core reports', async () => {
      const runtimeDevice = {
        loaded_backends: ['CUDA', 'CPU'],
        primary_device: 'CUDA0',
        gpu_layers_offloaded: 33,
        total_layers: 33,
      }
      vi.mocked(invoke).mockResolvedValue({
        sessions: [
          {
            model_id: 'test-model',
            pid: 7,
            port: 3000,
            provider: 'llamacpp-upstream',
            runtime_device: runtimeDevice,
          },
        ],
      })

      await expect(extension.getRuntimeDeviceInfo('test-model')).resolves.toEqual(
        runtimeDevice
      )
      // The plugin's process table never held a core-owned pid, so it is not asked.
      expect(
        vi.mocked(invoke).mock.calls.map(([command]) => command)
      ).toEqual(['atomic_core_call'])
    })

    it('answers null for a model that is not loaded or has no device yet', async () => {
      vi.mocked(invoke).mockResolvedValue({
        sessions: [{ model_id: 'other', provider: 'llamacpp-upstream' }],
      })
      await expect(extension.getRuntimeDeviceInfo('test-model')).resolves.toBeNull()

      vi.mocked(invoke).mockResolvedValue({
        sessions: [{ model_id: 'test-model', provider: 'llamacpp-upstream' }],
      })
      await expect(extension.getRuntimeDeviceInfo('test-model')).resolves.toBeNull()
    })

    it('never throws, because telemetry must not break a load', async () => {
      vi.mocked(invoke).mockRejectedValue(new Error('core is gone'))

      await expect(extension.getRuntimeDeviceInfo('test-model')).resolves.toBeNull()
    })
  })

  describe('getLoadedModels', () => {
    it('returns the models the core serves for this provider', async () => {
      vi.mocked(invoke).mockResolvedValue({
        sessions: [
          { model_id: 'model1', provider: 'llamacpp-upstream' },
          { model_id: 'model2', provider: 'llamacpp-upstream' },
          { model_id: 'tq-model', provider: 'llamacpp' },
        ],
      })

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

  describe('configureBackends', () => {
    // Mirrors `settings.json`: `version_backend` ships with an empty options
    // list, so the list this method assembles is the only thing standing
    // between the stored value and core's `options[0]` fallback.
    const settingsSchema = [
      {
        key: 'version_backend',
        title: 'Version & Backend',
        controllerType: 'dropdown',
        controllerProps: { value: 'none', options: [], recommended: '' },
      },
    ]

    // The guest-js bridge is mocked with `importActual`, so the release lookup
    // and the migration probe reach the real `@tauri-apps/api/core` and have to
    // be stubbed at the Tauri bridge.
    afterEach(() => {
      delete (window as any).__TAURI_INTERNALS__
    })

    it('offers the saved release even when neither the manifest nor the disk has it', async () => {
      ;(window as any).__TAURI_INTERNALS__ = {
        invoke: vi.fn().mockResolvedValue(null),
      }
      vi.stubGlobal('IS_MAC', true)
      vi.stubGlobal('IS_WINDOWS', false)
      vi.stubGlobal('IS_LINUX', false)
      vi.stubGlobal('SETTINGS', settingsSchema)

      const saved = 'b10344/macos-arm64'
      extension['config'] = { version_backend: saved } as any
      extension['tryInstallBundledBackend'] = vi.fn().mockResolvedValue(null)
      // The manifest advertises the newest tag only, and the saved build's
      // directory is gone — pruned by the update that installed b10405.
      vi.mocked(listSupportedBackends).mockResolvedValue([
        { version: 'b10405', backend: 'macos-arm64' },
      ] as any)
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([])
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(mapOldBackendToNew).mockImplementation(async (b: string) => b)
      extension['determineBestBackend'] = vi
        .fn()
        .mockResolvedValue('b10405/macos-arm64')
      extension['getStoredBackendType'] = vi.fn().mockReturnValue('macos-arm64')
      extension['setStoredBackendType'] = vi.fn()
      extension['getSetting'] = vi.fn().mockResolvedValue(saved)
      extension['getSettings'] = vi.fn().mockResolvedValue([])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)
      const registerSettings = vi.fn()
      extension['registerSettings'] = registerSettings

      await extension.configureBackends()

      const registered = (
        registerSettings.mock.calls.at(-1)?.[0] as any[]
      )?.find((s) => s.key === 'version_backend')
      const offered = registered.controllerProps.options.map(
        (o: any) => o.value
      )

      // Dropping the saved value from the list hands it to core's fallback,
      // which replaces it with `options[0]` — the `latest/` sentinel that
      // `reconcileBackendReleaseTag` cannot act on, leaving the provider with
      // no version check at all.
      expect(offered).toContain(saved)
      expect(offered).toContain('latest/macos-arm64')
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
      // The core commits an optimal-backend record before the UI copy is written; accept every
      // write at the next revision so the tests below see the copy follow the commit.
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        const call = args as
          | { method?: string; path?: string; body?: { optimal?: unknown } }
          | undefined
        if (
          command === 'atomic_core_call' &&
          call?.method === 'PUT' &&
          call.path === '/backends/llamacpp-upstream/optimal'
        ) {
          return {
            status: 'updated',
            current: { revision: 1, optimal: call.body?.optimal ?? null },
          }
        }
        return undefined
      })
      extension['config'] = {
        version_backend: 'b9800/win-cpu-x64',
        device: '',
      } as any
    })

    afterEach(() => {
      delete (window as any).dispatchEvent
    })

    describe('reconcileBackendReleaseTag', () => {
      /// Offer published by the last `reconcileBackendReleaseTag()` run, read
      /// off the persisted mirror the banner boots from (ATO-528).
      const publishedOffer = () => {
        const call = vi
          .mocked(localStorage.setItem)
          .mock.calls.find(
            ([key]) => key === 'atomic_engine_update_offer_llamacpp-upstream'
          )
        return call ? JSON.parse(call[1] as string) : null
      }

      beforeEach(() => {
        vi.mocked(mapOldBackendToNew).mockImplementation(async (b: string) => b)
        ;(window as any).dispatchEvent = vi.fn()
      })

      it('offers the newest manifest release instead of taking it', async () => {
        extension['config'] = {
          version_backend: 'b9937/win-cuda-13.3-x64',
        } as any
        extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
          updateNeeded: true,
          newVersion: 'b10344',
          targetBackend: 'b10344/win-cuda-13.3-x64',
        })
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['reconcileBackendReleaseTag']()

        // The whole point of ATO-528: a launch no longer starts a several
        // hundred megabyte transfer the user never asked for.
        expect(extension.downloadRecommendedBackend).not.toHaveBeenCalled()
        const offer = publishedOffer()
        expect(offer).toMatchObject({
          provider: 'llamacpp-upstream',
          currentBackend: 'b9937/win-cuda-13.3-x64',
          targetBackend: 'b10344/win-cuda-13.3-x64',
          currentVersion: 'b9937',
          targetVersion: 'b10344',
          restartRequired: false,
          releaseNotesUrl:
            'https://github.com/ggml-org/llama.cpp/releases/tag/b10344',
        })
        // The core downloads from the signed mirror; the extension no longer knows the size.
        expect(offer.downloadSizeBytes).toBeUndefined()
        const event = vi.mocked((window as any).dispatchEvent).mock
          .calls[0]?.[0] as CustomEvent
        expect(event?.type).toBe('app:engine-update-available')
        expect(event?.detail).toMatchObject({
          targetBackend: 'b10344/win-cuda-13.3-x64',
        })
      })

      it('leaves the newest release alone', async () => {
        extension['config'] = { version_backend: RECOMMENDED } as any
        extension.checkBackendForUpdates = vi
          .fn()
          .mockResolvedValue({ updateNeeded: false, newVersion: '0' })
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['reconcileBackendReleaseTag']()

        expect(extension.downloadRecommendedBackend).not.toHaveBeenCalled()
      })

      it('refuses to cross backend families', async () => {
        extension['config'] = {
          version_backend: 'b9937/win-vulkan-x64',
        } as any
        extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
          updateNeeded: true,
          newVersion: 'b10344',
          targetBackend: 'b10344/win-cpu-x64',
        })
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['reconcileBackendReleaseTag']()

        expect(extension.downloadRecommendedBackend).not.toHaveBeenCalled()
      })

      it('offers a tag bump on macOS, where the family never changes', async () => {
        extension['config'] = {
          version_backend: 'b10205/macos-arm64',
        } as any
        extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
          updateNeeded: true,
          newVersion: 'b10344',
          targetBackend: 'b10344/macos-arm64',
        })
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['reconcileBackendReleaseTag']()

        expect(extension.downloadRecommendedBackend).not.toHaveBeenCalled()
        expect(publishedOffer()).toMatchObject({
          currentBackend: 'b10205/macos-arm64',
          targetBackend: 'b10344/macos-arm64',
        })
      })

      it('resolves a sentinel parked in the config instead of skipping it', async () => {
        // A `latest/<variant>` value here is not a fresh install: it is what
        // core's `registerSettings()` leaves behind when the stored concrete
        // tag falls out of the options list. Skipping it used to switch off
        // automatic engine updates for the rest of the installation's life.
        extension['config'] = {
          version_backend: 'latest/macos-arm64',
        } as any
        extension.checkBackendForUpdates = vi.fn()
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockResolvedValue(undefined)

        await extension['reconcileBackendReleaseTag']()

        expect(extension.downloadRecommendedBackend).toHaveBeenCalledWith(
          'latest/macos-arm64'
        )
        expect(extension.checkBackendForUpdates).not.toHaveBeenCalled()
      })

      it('keeps the working backend when the sentinel download fails', async () => {
        // The parked-sentinel recovery is the one leg that still downloads on
        // its own; a failure there must not disturb the running backend.
        const current = 'latest/win-vulkan-x64'
        extension['config'] = { version_backend: current } as any
        extension.checkBackendForUpdates = vi.fn()
        extension.downloadRecommendedBackend = vi
          .fn()
          .mockRejectedValue(new Error('asset unavailable'))

        await expect(
          extension['reconcileBackendReleaseTag']()
        ).resolves.toBeUndefined()
        expect(extension['config'].version_backend).toBe(current)
      })
    })

    describe('checkForEngineUpdate', () => {
      beforeEach(() => {
        vi.mocked(mapOldBackendToNew).mockImplementation(async (b: string) => b)
        extension['configureBackendsPromise'] = null
      })

      it('reports the newest release of the backend type in use', async () => {
        extension['config'] = {
          version_backend: 'b10205/win-cuda-13.3-x64',
        } as any
        extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
          updateNeeded: true,
          newVersion: 'b10344',
          targetBackend: 'b10344/win-cuda-13.3-x64',
        })

        await expect(extension.checkForEngineUpdate()).resolves.toEqual({
          updateAvailable: true,
          targetBackend: 'b10344/win-cuda-13.3-x64',
        })
        // The session manifest cache is exactly what hides a release published
        // while the app was open, so the check must bypass it.
        expect(extension.checkBackendForUpdates).toHaveBeenCalledWith({
          force: true,
        })
      })

      it('reports no update when the catalog has nothing newer', async () => {
        extension['config'] = {
          version_backend: 'b10344/win-cpu-x64',
        } as any
        extension.checkBackendForUpdates = vi
          .fn()
          .mockResolvedValue({ updateNeeded: false, newVersion: '0' })

        await expect(extension.checkForEngineUpdate()).resolves.toEqual({
          updateAvailable: false,
          targetBackend: null,
        })
      })

      it('never crosses backend families', async () => {
        extension['config'] = {
          version_backend: 'b10205/win-vulkan-x64',
        } as any
        extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
          updateNeeded: true,
          newVersion: 'b10344',
          targetBackend: 'b10344/win-cuda-13.3-x64',
        })

        await expect(extension.checkForEngineUpdate()).resolves.toEqual({
          updateAvailable: false,
          targetBackend: null,
        })
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
        // A recommendation was produced, so there is no "why nothing" to give.
        expect(extension.getLastRecheckOutcome()).toBeNull()
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
        // The healthy outcome, and almost certainly the most common one. It
        // used to reach telemetry as the same `no_recommendation` as a genuine
        // gap in the catalog, which is why that number could not be read.
        expect(extension.getLastRecheckOutcome()).toBe('already_optimal')
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
        expect(extension.getLastRecheckOutcome()).toBe('cpu_optimal')
      })

      it('says the catalog had nothing for the detected type', async () => {
        vi.spyOn(extension as any, 'detectIdealBackendType').mockResolvedValue({
          kind: 'gpu',
          backend: 'win-cuda-13.3-x64',
        })
        // Detection picked a tier the catalog cannot serve.
        vi.spyOn(
          extension as any,
          'resolveConcreteOptimalBackend'
        ).mockResolvedValue(null)

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        // A gap on our side, not a property of the machine — the distinction
        // the single `no_recommendation` value used to erase.
        expect(extension.getLastRecheckOutcome()).toBe('no_catalog_entry')
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
    })
  })
})
