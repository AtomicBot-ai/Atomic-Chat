import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import llamacpp_extension from '../index'
import type {
  CoreBackendRecommendation,
  CoreBackendUpdateCheck,
} from '../../../shared/atomicCoreRuntime'

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
// stable-release rules rather than a second copy of them. The catalog comes
// from the core (ADR 2026-09-27); here it never arrives, which is the
// "continue with the bundled build" path of `configureBackends`.
vi.mock('../backend', async () => {
  const actual = await vi.importActual<typeof import('../backend')>('../backend')
  return {
    ...actual,
    isBackendInstalled: vi.fn(),
    getBackendExePath: vi.fn(),
    getBackendDir: vi.fn(),
    loadCatalog: vi.fn(async () => {
      throw new Error('no catalog in this test')
    }),
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
      mapOldBackendToNew: vi.fn(),
      removeOldBackendVersions: vi.fn(),
      readGgufMetadata: vi.fn(),
    }
  }
)

/// One answer of `POST /backends/llamacpp/recommendation`, as the core's
/// adapter hands it over; tests override the parts that matter to them.
const coreRecommendation = (
  partial: Partial<CoreBackendRecommendation<any, any>>
): CoreBackendRecommendation<any, any> => ({
  provider: 'llamacpp',
  mode: 'recheck',
  outcome: 'already_optimal',
  detection: null,
  record: null,
  revision: 1,
  optimal: null,
  recommendation: null,
  elapsed_ms: 5,
  ...partial,
})

// A backend install the core runs reports through `listen('download-<taskId>')`.
vi.mock('@tauri-apps/api/event', () => ({
  listen: vi.fn(async () => () => {}),
  emit: vi.fn(async () => undefined),
}))

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

    it('leaves out a model the core set up for the PrismML engine', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')
      const { invoke } = await import('@tauri-apps/api/core')
      extension['providerPath'] = '/path/to/jan/llamacpp'
      const modelsDir = '/path/to/jan/llamacpp/models'
      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        [
          modelsDir,
          `${modelsDir}/plain/model.yml`,
          `${modelsDir}/bonsai/model.yml`,
        ].includes(path)
      )
      vi.mocked(fs.readdirSync).mockResolvedValue(['plain', 'bonsai'])
      vi.mocked(fs.fileStat).mockResolvedValue({ isDirectory: true, size: 1 })
      vi.mocked(invoke).mockImplementation(async (_command, args) =>
        String((args as { path?: string })?.path).includes('/bonsai/')
          ? {
              model_path: 'bonsai/model.gguf',
              name: 'Bonsai',
              atomic_runtime: { provider: 'atomic-prism' },
            }
          : { model_path: 'plain/model.gguf', name: 'Plain' }
      )
      const { readGgufMetadata } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(readGgufMetadata).mockResolvedValue({
        version: 3,
        tensor_count: 1,
        metadata: { 'general.architecture': 'llama' },
      } as any)

      const result = await extension.list()

      expect(result.map((model) => model.id)).toEqual(['plain'])
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
      const { readGgufMetadata } = await import(
        '../../../../src-tauri/plugins/tauri-plugin-llamacpp/guest-js/index'
      )
      vi.mocked(readGgufMetadata).mockResolvedValue({
        version: 3,
        tensor_count: 1,
        metadata: { 'general.architecture': 'llama' },
      } as any)

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

    // A failed hash check used to `fs.rm` the whole model directory, which is
    // shared with the mmproj, the drafts and the sibling shards of a model that
    // may already be installed and working.
    it('removes only the failed download, keeping the rest of the model folder', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')

      const mockDownloadManager = {
        downloadFiles: vi
          .fn()
          .mockRejectedValue(
            new Error('Hash verification failed for model.gguf')
          ),
        cancelDownload: vi.fn().mockResolvedValue(undefined),
      }
      window.core.extensionManager.getByName = vi
        .fn()
        .mockReturnValue(mockDownloadManager)

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      // Everything is on disk except the config: the model was mid-import.
      vi.mocked(fs.existsSync).mockImplementation((path: string) =>
        Promise.resolve(!path.endsWith('model.yml'))
      )
      vi.mocked(fs.readdirSync).mockResolvedValue(['mmproj.gguf'])
      vi.mocked(fs.rm).mockResolvedValue(undefined)

      await expect(
        extension.import('test-model', {
          modelPath: 'https://example.com/model.gguf',
        })
      ).rejects.toThrow('Hash verification failed')

      const removed = vi.mocked(fs.rm).mock.calls.map(([path]) => path)
      expect(removed).toEqual([
        '/path/to/jan/llamacpp/models/test-model/model.gguf',
        '/path/to/jan/llamacpp/models/test-model/model.gguf.tmp',
        '/path/to/jan/llamacpp/models/test-model/model.gguf.url',
        '/path/to/jan/llamacpp/models/test-model/model.gguf.parts',
      ])
      expect(removed).not.toContain('/path/to/jan/llamacpp/models/test-model')
    })

    // Field feedback, 2026-09-29: a dead connection read as a live download,
    // because the model pull never passed the downloader's stages on.
    it('passes the downloader stages to the model row', async () => {
      const { getJanDataFolderPath, joinPath, fs, events } = await import(
        '@janhq/core'
      )
      const stage = { kind: 'stalled', attempt: 0, maxAttempts: 5 }
      const mockDownloadManager = {
        downloadFiles: vi.fn(
          async (
            _items: unknown,
            _taskId: string,
            _onProgress: unknown,
            _resume: boolean,
            onStage?: (stage: unknown) => void
          ) => {
            onStage?.(stage)
            throw new Error('Download cancelled')
          }
        ),
        cancelDownload: vi.fn().mockResolvedValue(undefined),
      }
      window.core.extensionManager.getByName = vi
        .fn()
        .mockReturnValue(mockDownloadManager)
      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      vi.mocked(fs.existsSync).mockResolvedValue(false)

      await expect(
        extension.import('test-model', {
          modelPath: 'https://example.com/model.gguf',
        })
      ).rejects.toThrow()

      expect(events.emit).toHaveBeenCalledWith('onFileDownloadUpdate', {
        modelId: 'test-model',
        downloadType: 'Model',
        stage,
      })
    })

    it('removes the model folder when the failed download left it empty', async () => {
      const { getJanDataFolderPath, joinPath, fs } = await import('@janhq/core')

      const mockDownloadManager = {
        downloadFiles: vi
          .fn()
          .mockRejectedValue(new Error('Size verification failed')),
        cancelDownload: vi.fn().mockResolvedValue(undefined),
      }
      window.core.extensionManager.getByName = vi
        .fn()
        .mockReturnValue(mockDownloadManager)

      vi.mocked(getJanDataFolderPath).mockResolvedValue('/path/to/jan')
      vi.mocked(joinPath).mockImplementation((paths) =>
        Promise.resolve(paths.join('/'))
      )
      vi.mocked(fs.existsSync).mockImplementation((path: string) =>
        Promise.resolve(!path.endsWith('model.yml'))
      )
      vi.mocked(fs.readdirSync).mockResolvedValue([])
      vi.mocked(fs.rm).mockResolvedValue(undefined)

      await expect(
        extension.import('test-model', {
          modelPath: 'https://example.com/model.gguf',
        })
      ).rejects.toThrow('Size verification failed')

      expect(vi.mocked(fs.rm).mock.calls.map(([path]) => path)).toContain(
        '/path/to/jan/llamacpp/models/test-model'
      )
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
      extension['loadThroughCore'] = vi.fn().mockResolvedValue(session)
      global.fetch = vi.fn().mockResolvedValue({
        ok: true,
        json: vi.fn().mockResolvedValue({ status: 'ok' }),
      })

      const result = await extension.load('test-model')

      expect(result).toEqual(session)
      expect(extension['loadThroughCore']).toHaveBeenCalledWith(
        'test-model',
        undefined,
        false,
        false,
        undefined
      )
    })

    it('keeps the code on a core refusal and names the stages a watcher waits on', async () => {
      extension['findSessionByModel'] = vi.fn().mockResolvedValue(null)
      extension['coreSettings'] = { ensureReady: vi.fn(async () => undefined) } as any
      extension['isConfiguredBackendInstalled'] = vi.fn(async () => false)
      extension['modelFilePaths'] = vi.fn(async () => ['/data/llamacpp/models/m/model.gguf'])
      const session = { model_id: 'm', pid: 1, port: 2, api_key: 'k' }
      const stages: unknown[] = []
      extension['core'] = {
        load: vi.fn(async () => session),
        unload: vi.fn(),
        cancelLoad: vi.fn(async () => true),
      } as any
      extension['loadCancel'] = new (await import('../../../shared/loadCancel')).LoadCancelTracker(
        extension['core'] as any
      )
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === 'get_page_cache_resident_fraction' ? 0.5 : undefined
      )
      await expect(
        extension.load('m', undefined, false, false, { onStage: (stage) => stages.push(stage) })
      ).resolves.toEqual(session)
      expect(stages).toEqual([
        { kind: 'installingEngine' },
        { kind: 'loadingWeights', cachedFraction: 0.5 },
      ])

      extension['core'].load = vi.fn(async () => {
        throw { code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' }
      })
      await expect(extension.load('m')).rejects.toMatchObject({
        code: 'MODEL_LOAD_CANCELLED',
        message: 'The model load was cancelled. [MODEL_LOAD_CANCELLED]',
      })
    })

    it('cancels a load through the core, and the load rejects as cancelled', async () => {
      extension['findSessionByModel'] = vi.fn().mockResolvedValue(null)
      extension['coreSettings'] = { ensureReady: vi.fn(async () => undefined) } as any
      let rejectLoad!: (error: unknown) => void
      extension['core'] = {
        load: vi.fn(() => new Promise((_, reject) => (rejectLoad = reject))),
        unload: vi.fn(),
        cancelLoad: vi.fn(async () => {
          rejectLoad({ code: 'MODEL_LOAD_CANCELLED', message: 'The model load was cancelled.' })
          return true
        }),
      } as any
      extension['loadCancel'] = new (await import('../../../shared/loadCancel')).LoadCancelTracker(
        extension['core'] as any
      )
      expect(await extension.cancelLoad('m')).toBe(false)
      const load = extension.load('m')
      load.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 0))
      expect(await extension.cancelLoad('m')).toBe(true)
      expect(extension['core'].cancelLoad).toHaveBeenCalledWith('m')
      await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
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

      // The session comes from the core's session list, asked on every call.
      vi.mocked(invoke).mockResolvedValue({
        sessions: [
          {
            model_id: 'test-model',
            pid: 123,
            port: 3000,
            api_key: 'test-key',
            provider: 'llamacpp',
          },
        ],
      })

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

  describe('migrateConcurrentModeOff', () => {
    it('switches a stored Concurrent Mode off and leaves the rest alone', async () => {
      // The settings UI no longer shows the toggle, so a profile left with it
      // on would split the context across slots with no way back.
      extension['config'] = {
        concurrent_mode: true,
        concurrent_slots: 8,
      } as any
      extension['getSettings'] = vi.fn().mockResolvedValue([
        { key: 'concurrent_mode', controllerProps: { value: true } },
        { key: 'concurrent_slots', controllerProps: { value: 8 } },
      ])
      extension['updateSettings'] = vi.fn().mockResolvedValue(undefined)

      await extension['migrateConcurrentModeOff']()

      const updated = vi.mocked(extension['updateSettings']).mock.calls[0][0]
      expect(
        updated.find((s: any) => s.key === 'concurrent_mode').controllerProps
          .value
      ).toBe(false)
      expect(
        updated.find((s: any) => s.key === 'concurrent_slots').controllerProps
          .value
      ).toBe(8)
      expect(extension['config'].concurrent_mode).toBe(false)
    })

    it('writes nothing when Concurrent Mode is already off', async () => {
      extension['config'] = { concurrent_mode: false } as any
      extension['getSettings'] = vi.fn()
      extension['updateSettings'] = vi.fn()

      await extension['migrateConcurrentModeOff']()

      expect(extension['getSettings']).not.toHaveBeenCalled()
      expect(extension['updateSettings']).not.toHaveBeenCalled()
    })
  })
  describe('getLoadedModels', () => {
    it('should return the models the core runs for this provider', async () => {
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockResolvedValue({
        sessions: [
          { model_id: 'model1', provider: 'llamacpp' },
          { model_id: 'upstream-model', provider: 'llamacpp-upstream' },
          { model_id: 'model2', provider: 'llamacpp' },
        ],
      })

      const result = await extension.getLoadedModels()

      expect(result).toEqual(['model1', 'model2'])
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'GET',
        path: '/sessions',
        body: null,
      })
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

  describe('backend install through the core', () => {
    it('routes a relayed stage frame to the row status, not the progress bar', async () => {
      const { events } = await import('@janhq/core')
      const { listen } = await import('@tauri-apps/api/event')
      type Frame = {
        transferred: number
        total: number
        stage?: { kind: string; attempt: number; maxAttempts: number }
      }
      let frame: ((event: { payload: Frame }) => void) | undefined
      const unlisten = vi.fn()
      vi.mocked(listen).mockImplementation(async (_name, callback) => {
        frame = callback as typeof frame
        return unlisten
      })
      const stage = { kind: 'retrying', attempt: 2, maxAttempts: 5 }
      extension['core'] = {
        installBackend: vi.fn(async () => {
          frame?.({ payload: { transferred: 10, total: 20 } })
          // What the relay makes of the core's `download:stage`: the same name, counters at zero.
          frame?.({ payload: { transferred: 0, total: 0, stage } })
          frame?.({ payload: { transferred: 15, total: 20 } })
          return { installed: true, version: 'b1', backend: 'macos-arm64', path: '/pack' }
        }),
      } as any

      await extension['installBackendThroughCore']('b1/macos-arm64', 'b1', 'macos-arm64')

      const taskId = 'llamacpp-backend-b1/macos-arm64'
      expect(vi.mocked(listen).mock.calls[0]?.[0]).toBe(`download-${taskId}`)
      const updates = vi
        .mocked(events.emit)
        .mock.calls.filter(([name]) => name === 'onFileDownloadUpdate')
        .map(([, payload]) => payload)
      expect(updates).toEqual([
        {
          modelId: taskId,
          percent: 0.5,
          size: { transferred: 10, total: 20 },
          downloadType: 'Backend',
        },
        { modelId: taskId, downloadType: 'Backend', stage },
        {
          modelId: taskId,
          percent: 0.75,
          size: { transferred: 15, total: 20 },
          downloadType: 'Backend',
        },
      ])
      expect(unlisten).toHaveBeenCalledOnce()
    })

    it('names the row after the task id when a stage frame comes before any byte', async () => {
      const { events } = await import('@janhq/core')
      const { listen } = await import('@tauri-apps/api/event')
      type Frame = {
        transferred: number
        total: number
        stage?: { kind: string; attempt: number; maxAttempts: number }
      }
      let frame: ((event: { payload: Frame }) => void) | undefined
      vi.mocked(listen).mockImplementation(async (_name, callback) => {
        frame = callback as typeof frame
        return vi.fn()
      })
      // The core's order: the preflight's stages, then the bytes.
      const connecting = { kind: 'connecting', attempt: 0, maxAttempts: 6 }
      const retrying = { kind: 'retrying', attempt: 1, maxAttempts: 6 }
      extension['core'] = {
        installBackend: vi.fn(async () => {
          frame?.({ payload: { transferred: 0, total: 0, stage: connecting } })
          frame?.({ payload: { transferred: 0, total: 0, stage: retrying } })
          frame?.({ payload: { transferred: 10, total: 20 } })
          return { installed: true, version: 'b1', backend: 'macos-arm64', path: '/pack' }
        }),
      } as any

      await extension['installBackendThroughCore']('b1/macos-arm64', 'b1', 'macos-arm64')

      const taskId = 'llamacpp-backend-b1/macos-arm64'
      const updates = vi
        .mocked(events.emit)
        .mock.calls.filter(([name]) => name === 'onFileDownloadUpdate')
        .map(([, payload]) => payload)
      expect(updates).toEqual([
        // A progress update names the row (a stage update would leave it blank, and its Cancel
        // would not reach the core task), once.
        {
          modelId: taskId,
          percent: 0,
          size: { transferred: 0, total: 0 },
          downloadType: 'Backend',
        },
        { modelId: taskId, downloadType: 'Backend', stage: connecting },
        { modelId: taskId, downloadType: 'Backend', stage: retrying },
        {
          modelId: taskId,
          percent: 0.5,
          size: { transferred: 10, total: 20 },
          downloadType: 'Backend',
        },
      ])
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

    beforeEach(async () => {
      vi.stubGlobal('IS_MAC', false)
      vi.stubGlobal('IS_WINDOWS', false)
      vi.mocked(localStorage.getItem).mockReset()
      vi.mocked(localStorage.setItem).mockReset()
      vi.mocked(localStorage.removeItem).mockReset()
      extension['config'] = {
        version_backend: 'v1.0.0/windows-x64-cpu',
        device: '',
      } as any
      // The optimal-backend record is stored in the core; accept every write.
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockImplementation((async (
        command: string,
        args?: { method?: string; path?: string; body?: any }
      ) => {
        if (
          command === 'atomic_core_call' &&
          args?.method === 'PUT' &&
          args.path === '/backends/llamacpp/optimal'
        ) {
          return {
            status: 'updated',
            current: {
              revision: args.body.expected_revision + 1,
              optimal: args.body.optimal,
            },
          }
        }
        return undefined
      }) as never)
    })

    afterEach(async () => {
      delete (window as any).dispatchEvent
      const { invoke } = await import('@tauri-apps/api/core')
      vi.mocked(invoke).mockReset()
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

    /// Since ADR 2026-09-27 the core decides — probes the hardware, resolves
    /// the release index, picks the tier and stores the optimal record. What
    /// is left here is the contract with the web-app: which outcome becomes
    /// which telemetry value, the sentinel, the mirror of the core's record,
    /// one dialog per recommendation, and never a write back to the core.
    describe('recheckOptimalBackend', () => {
      const GPU_RECORD = {
        schemaVersion: 1,
        detectedAt: 1_722_345_678_901,
        provider: 'llamacpp',
        detectionKind: 'gpu',
        currentBackend: 'v1.0.0/windows-x64-cpu',
        idealBackendId: 'windows-x64-cuda-13.3',
        recommendedBackend: RECOMMENDED,
        recommendedCategory: 'CUDA 13',
      }
      const RECOMMEND_PAYLOAD = {
        currentBackend: 'v1.0.0/windows-x64-cpu',
        recommendedBackend: RECOMMENDED,
        recommendedCategory: 'CUDA 13',
        version: 'v1.2.0',
        backendId: 'windows-x64-cuda-13.3',
      }

      const coreAnswers = (
        partial: Partial<CoreBackendRecommendation<any, any>>
      ) =>
        vi
          .spyOn(extension['core'], 'recommendBackend')
          .mockResolvedValue(coreRecommendation(partial))

      it('surfaces the core\'s recommendation once, under this provider', async () => {
        const recommend = coreAnswers({
          outcome: 'recommend',
          detection: { kind: 'gpu', backend: 'windows-x64-cuda-13.3' },
          record: GPU_RECORD,
          revision: 7,
          optimal: GPU_RECORD,
          recommendation: RECOMMEND_PAYLOAD,
        })
        const setOptimal = vi.spyOn(extension['core'], 'setOptimalCache')

        const result = await extension.recheckOptimalBackend()

        // A recheck bypasses the core's index cache and names the build in use.
        expect(recommend).toHaveBeenCalledTimes(1)
        expect(recommend).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'recheck',
            current_backend: 'v1.0.0/windows-x64-cpu',
            app_version: '1.0.0',
          })
        )
        expect(result).toEqual({ ...RECOMMEND_PAYLOAD, provider: 'llamacpp' })
        expect(localStorage.setItem).toHaveBeenCalledWith(
          RECOMMENDATION_KEY,
          JSON.stringify(result)
        )

        // The core's record is mirrored, never written back (it stored it).
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          JSON.stringify(GPU_RECORD)
        )
        expect(extension['optimalRevision']).toBe(7)
        expect(setOptimal).not.toHaveBeenCalled()

        // One dialog: the core's own `backend:better-detected` is not relayed.
        const { events, AppEvent } = await import('@janhq/core')
        const dialogs = vi
          .mocked(events.emit)
          .mock.calls.filter(([name]) => name === AppEvent.onBetterBackendDetected)
        expect(dialogs).toEqual([[AppEvent.onBetterBackendDetected, result]])
        // A recommendation was produced, so there is no "why nothing" to give.
        expect(extension.getLastRecheckOutcome()).toBeNull()
      })

      it.each([
        ['already_optimal', { ...GPU_RECORD, recommendedBackend: 'v1.0.0/windows-x64-cpu' }],
        ['cpu_optimal', { ...GPU_RECORD, detectionKind: 'cpu-optimal', recommendedCategory: 'CPU' }],
        ['no_catalog_entry', { ...GPU_RECORD, recommendedBackend: undefined }],
        ['mac', null],
      ] as const)(
        'returns nothing, records %s and forgets any stale recommendation',
        async (outcome, record) => {
          coreAnswers({ outcome, record, optimal: record, revision: 2 })

          await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

          expect(localStorage.removeItem).toHaveBeenCalledWith(RECOMMENDATION_KEY)
          expect(localStorage.setItem).not.toHaveBeenCalledWith(
            RECOMMENDATION_KEY,
            expect.anything()
          )
          if (record) {
            expect(localStorage.setItem).toHaveBeenCalledWith(
              OPTIMAL_CACHE_KEY,
              JSON.stringify(record)
            )
          }
          const { events, AppEvent } = await import('@janhq/core')
          expect(events.emit).not.toHaveBeenCalledWith(
            AppEvent.onBetterBackendDetected,
            expect.anything()
          )
          // The vocabulary telemetry reads: `already_optimal` is the healthy
          // outcome, `no_catalog_entry` a gap on our side, not of the machine.
          expect(extension.getLastRecheckOutcome()).toBe(outcome)
        }
      )

      it('raises a distinct signal when the core could not detect', async () => {
        coreAnswers({
          outcome: 'detection_failed',
          detection: { kind: 'detection-failed' },
          revision: 3,
        })

        await expect(extension.recheckOptimalBackend()).rejects.toThrow(
          'BACKEND_DETECTION_FAILED'
        )

        // The current backend and any earlier recommendation stay untouched.
        expect(localStorage.setItem).not.toHaveBeenCalled()
        expect(localStorage.removeItem).not.toHaveBeenCalled()
        expect(extension['optimalRevision']).toBe(0)
      })

      it('raises the same signal when the core never answers', async () => {
        vi.useFakeTimers()
        try {
          vi.spyOn(extension['core'], 'recommendBackend').mockReturnValue(
            new Promise(() => {})
          )

          const pending = extension.recheckOptimalBackend()
          pending.catch(() => {})
          await vi.advanceTimersByTimeAsync(30_000)

          await expect(pending).rejects.toThrow('BACKEND_DETECTION_FAILED')
        } finally {
          vi.useRealTimers()
        }
      })

      it('reports a failed call as threw, not as an outcome', async () => {
        vi.spyOn(extension['core'], 'recommendBackend').mockRejectedValue(
          new Error('core unreachable')
        )

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(extension.getLastRecheckOutcome()).toBe('threw')
        expect(localStorage.setItem).not.toHaveBeenCalled()
      })

      it('ignores an answer older than the record already applied', async () => {
        extension['applyOptimalState']({ revision: 9, optimal: GPU_RECORD as any })
        vi.mocked(localStorage.setItem).mockClear()
        coreAnswers({
          outcome: 'cpu_optimal',
          record: { ...GPU_RECORD, detectionKind: 'cpu-optimal' },
          optimal: { ...GPU_RECORD, detectionKind: 'cpu-optimal' },
          revision: 4,
        })

        await extension.recheckOptimalBackend()

        expect(extension['optimalRevision']).toBe(9)
        expect(localStorage.setItem).not.toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          expect.anything()
        )
      })

      it('does not ask on macOS, which publishes a single variant', async () => {
        vi.stubGlobal('IS_MAC', true)
        const recommend = vi.spyOn(extension['core'], 'recommendBackend')

        await expect(extension.recheckOptimalBackend()).resolves.toBeNull()

        expect(recommend).not.toHaveBeenCalled()
        expect(extension.getLastRecheckOutcome()).toBe('mac')
      })
    })

    describe('optimal backend cache', () => {
      const GPU_RECORD = {
        schemaVersion: 1,
        detectedAt: 1_722_345_678_901,
        provider: 'llamacpp',
        detectionKind: 'gpu',
        currentBackend: 'v1.0.0/windows-x64-cpu',
        idealBackendId: 'windows-x64-cuda-13.3',
        recommendedBackend: RECOMMENDED,
        recommendedCategory: 'CUDA 13',
      }
      const CPU_RECORD = {
        schemaVersion: 1,
        detectedAt: 1_722_345_678_901,
        provider: 'llamacpp',
        detectionKind: 'cpu-optimal',
        currentBackend: 'v1.0.0/windows-x64-cpu',
        recommendedCategory: 'CPU',
      }

      it('mirrors the GPU optimum the core stored without surfacing a recommendation', async () => {
        const recommend = vi
          .spyOn(extension['core'], 'recommendBackend')
          .mockResolvedValue(
            coreRecommendation({
              mode: 'refresh',
              outcome: 'recommend',
              record: GPU_RECORD,
              optimal: GPU_RECORD,
              revision: 5,
              recommendation: {
                currentBackend: 'v1.0.0/windows-x64-cpu',
                recommendedBackend: RECOMMENDED,
                recommendedCategory: 'CUDA 13',
                version: 'v1.2.0',
                backendId: 'windows-x64-cuda-13.3',
              },
            })
          )
        const setOptimal = vi.spyOn(extension['core'], 'setOptimalCache')

        const result = await extension.refreshOptimalBackendCache()

        expect(recommend).toHaveBeenCalledWith(
          expect.objectContaining({
            mode: 'refresh',
            current_backend: 'v1.0.0/windows-x64-cpu',
          })
        )
        expect(recommend.mock.calls[0][0]).not.toHaveProperty('assume_no_gpu')
        expect(result).toEqual(GPU_RECORD)
        expect(localStorage.setItem).toHaveBeenCalledWith(
          OPTIMAL_CACHE_KEY,
          JSON.stringify(GPU_RECORD)
        )
        expect(localStorage.setItem).not.toHaveBeenCalledWith(
          RECOMMENDATION_KEY,
          expect.anything()
        )
        expect(setOptimal).not.toHaveBeenCalled()

        const { events, AppEvent } = await import('@janhq/core')
        expect(events.emit).not.toHaveBeenCalledWith(
          AppEvent.onBetterBackendDetected,
          expect.anything()
        )
      })

      it('mirrors a genuine CPU optimum', async () => {
        vi.spyOn(extension['core'], 'recommendBackend').mockResolvedValue(
          coreRecommendation({
            mode: 'refresh',
            outcome: 'cpu_optimal',
            record: CPU_RECORD,
            optimal: CPU_RECORD,
          })
        )

        const result = await extension.refreshOptimalBackendCache()

        expect(result).toEqual(CPU_RECORD)
        expect(result).not.toHaveProperty('idealBackendId')
        expect(result).not.toHaveProperty('recommendedBackend')
      })

      it('hands the confirmed CPU-only fast path to the core', async () => {
        const recommend = vi
          .spyOn(extension['core'], 'recommendBackend')
          .mockResolvedValue(
            coreRecommendation({
              mode: 'refresh',
              outcome: 'cpu_optimal',
              record: CPU_RECORD,
              optimal: CPU_RECORD,
            })
          )

        const result = await extension.refreshOptimalBackendCache({
          hardwareHasNoGpu: true,
        })

        expect(result?.detectionKind).toBe('cpu-optimal')
        expect(recommend).toHaveBeenCalledWith(
          expect.objectContaining({ mode: 'refresh', assume_no_gpu: true })
        )
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
        vi.spyOn(extension['core'], 'recommendBackend').mockResolvedValue(
          coreRecommendation({
            mode: 'refresh',
            outcome: 'detection_failed',
            detection: { kind: 'detection-failed' },
          })
        )

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

  /// Engine update offers are the desktop's, from the core's
  /// `POST /engines/versions` (change unify-engine-lifecycle): the extension
  /// neither checks for a newer release on load nor publishes an offer.
  describe('engine update offers', () => {
    it('makes none of its own', () => {
      expect('reconcileBackendReleaseTag' in extension).toBe(false)
      expect('offerEngineUpdate' in extension).toBe(false)
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
        sameFamily: true,
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
        sameFamily: true,
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
        sameFamily: true,
      })

      const result = await extension.checkForEngineUpdate()

      expect(result.updateAvailable).toBe(false)
    })

    it('refuses to cross backend families', async () => {
      extension.checkBackendForUpdates = vi.fn().mockResolvedValue({
        updateNeeded: true,
        newVersion: 'b10269-1.4.0',
        targetBackend: 'b10269-1.4.0/linux-x64-cuda-13.3',
        sameFamily: false,
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

  /// The decision — newest tag of the type in use, same family or not — is the
  /// core's (ADR 2026-09-27); this side maps its answer onto the shape the
  /// reconciler and the settings button read.
  describe('checkBackendForUpdates', () => {
    const CURRENT = 'b9937-1.2.0/windows-x64-cuda-13.3'
    const TARGET = 'b10018-1.3.0/windows-x64-cuda-13.3'

    const coreSays = (partial: Partial<CoreBackendUpdateCheck>) =>
      vi.spyOn(extension['core'], 'checkBackendUpdates').mockResolvedValue({
        provider: 'llamacpp',
        current: CURRENT,
        current_kind: 'concrete',
        update_needed: false,
        new_version: '0',
        target_backend: null,
        same_family: false,
        offer: null,
        ...partial,
      })

    beforeEach(() => {
      extension['config'] = { version_backend: `﻿${CURRENT}` } as any
    })

    it('asks the core about the build in use and maps its verdict', async () => {
      const check = coreSays({
        update_needed: true,
        new_version: 'b10018-1.3.0',
        target_backend: TARGET,
        same_family: true,
        offer: TARGET,
      })

      await expect(
        extension.checkBackendForUpdates({ force: true })
      ).resolves.toEqual({
        updateNeeded: true,
        newVersion: 'b10018-1.3.0',
        targetBackend: TARGET,
        sameFamily: true,
      })
      expect(check).toHaveBeenCalledWith(
        expect.objectContaining({
          current: CURRENT,
          force: true,
          app_version: '1.0.0',
        })
      )
    })

    it('passes no force on the routine startup check', async () => {
      const check = coreSays({})

      await expect(extension.checkBackendForUpdates()).resolves.toEqual({
        updateNeeded: false,
        newVersion: '0',
        targetBackend: undefined,
        sameFamily: false,
      })
      expect(check.mock.calls[0][0]).not.toHaveProperty('force')
    })

    it('answers no update without asking when no concrete backend is configured', async () => {
      extension['config'] = { version_backend: 'none' } as any
      const check = vi.spyOn(extension['core'], 'checkBackendUpdates')

      await expect(extension.checkBackendForUpdates()).resolves.toEqual({
        updateNeeded: false,
        newVersion: '0',
      })
      expect(check).not.toHaveBeenCalled()
    })

    it('answers no update when the core cannot be reached', async () => {
      vi.spyOn(extension['core'], 'checkBackendUpdates').mockRejectedValue(
        new Error('core unreachable')
      )

      await expect(extension.checkBackendForUpdates()).resolves.toEqual({
        updateNeeded: false,
        newVersion: '0',
      })
    })
  })

  /// A clean install used to show CUDA in the dropdown while quietly running
  /// the bundled CPU build forever, unless the user walked through onboarding.
  describe('adoptOptimalBackendOnFirstRun', () => {
    const BUNDLED = 'b10018-1.3.0/windows-x64-cpu'
    const CUDA = 'b10269-1.4.0/windows-x64-cuda-13.3'
    const LATEST_BY_TYPE = {
      'windows-x64-cpu': 'b10269-1.4.0/windows-x64-cpu',
      'windows-x64-cuda-13.3': CUDA,
    }
    const CUDA_RECORD = {
      schemaVersion: 1,
      detectedAt: 1_722_345_678_901,
      provider: 'llamacpp',
      detectionKind: 'gpu',
      currentBackend: BUNDLED,
      idealBackendId: 'windows-x64-cuda-13.3',
      recommendedBackend: CUDA,
      recommendedCategory: 'CUDA 13',
    }

    const adopt = (storedType: string | null, active = BUNDLED) =>
      extension['adoptOptimalBackendOnFirstRun'](
        storedType,
        active,
        BUNDLED,
        LATEST_BY_TYPE
      )

    const coreAnswers = (
      partial: Partial<CoreBackendRecommendation<any, any>>
    ) =>
      vi
        .spyOn(extension['core'], 'recommendBackend')
        .mockResolvedValue(coreRecommendation({ mode: 'refresh', ...partial }))

    beforeEach(async () => {
      vi.stubGlobal('IS_MAC', false)
      extension['config'] = { version_backend: BUNDLED } as any
      extension['downloadRecommendedBackend'] = vi
        .fn()
        .mockResolvedValue(undefined)
      coreAnswers({
        outcome: 'recommend',
        detection: { kind: 'gpu', backend: 'windows-x64-cuda-13.3' },
        record: CUDA_RECORD,
        optimal: CUDA_RECORD,
      })
    })

    it('fetches the CUDA build a discrete NVIDIA host wants', async () => {
      await adopt(null)
      await extension['firstRunAdoption']

      // A silent refresh, naming the bundled build that is serving meanwhile.
      expect(extension['core'].recommendBackend).toHaveBeenCalledWith(
        expect.objectContaining({ mode: 'refresh', current_backend: BUNDLED })
      )
      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(CUDA)
    })

    it('leaves a user who already picked a backend untouched', async () => {
      await adopt('windows-x64-cpu')

      expect(extension['core'].recommendBackend).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('does not re-detect for someone already off the bundled build', async () => {
      await adopt(null, CUDA)

      expect(extension['core'].recommendBackend).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    // Download interrupted, app reopened: the preference is recorded but the
    // bundled build is still what runs. Resume it instead of asking hardware.
    it('finishes an adoption that never landed on disk', async () => {
      await adopt('windows-x64-cuda-13.3')
      await extension['firstRunAdoption']

      expect(extension['core'].recommendBackend).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).toHaveBeenCalledWith(CUDA)
    })

    it('stays on the bundled build when the stored type left the catalog', async () => {
      await adopt('windows-x64-vulkan')

      expect(extension['core'].recommendBackend).not.toHaveBeenCalled()
      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('stays on the bundled build when CPU is genuinely optimal', async () => {
      coreAnswers({
        outcome: 'cpu_optimal',
        record: { ...CUDA_RECORD, detectionKind: 'cpu-optimal' },
      })

      await adopt(null)

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    // Recording CPU here would look like a deliberate user preference forever
    // after, which ADR 2026-06-15 forbids.
    it('pins nothing when hardware detection fails', async () => {
      coreAnswers({
        outcome: 'detection_failed',
        detection: { kind: 'detection-failed' },
      })

      await expect(adopt(null)).resolves.toBeUndefined()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
      expect(extension['firstRunAdoption']).toBeNull()
    })

    it('pins nothing when the core cannot be reached', async () => {
      vi.spyOn(extension['core'], 'recommendBackend').mockRejectedValue(
        new Error('core unreachable')
      )

      await expect(adopt(null)).resolves.toBeUndefined()

      expect(extension['downloadRecommendedBackend']).not.toHaveBeenCalled()
    })

    it('pins nothing when the catalog has no build for this hardware', async () => {
      coreAnswers({
        outcome: 'no_catalog_entry',
        record: { ...CUDA_RECORD, recommendedBackend: undefined },
      })

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
        { 'macos-arm64': 'b10269-1.4.0/macos-arm64' }
      )

      expect(extension['core'].recommendBackend).not.toHaveBeenCalled()
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
