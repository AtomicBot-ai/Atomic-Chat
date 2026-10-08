import { describe, it, expect, vi, beforeEach, afterEach } from 'vitest'
import atomic_prism_extension, {
  BACKEND_DETECTION_FAILED,
  OPTIMAL_BACKEND_CACHE_KEY,
} from '../index'

import { readGgufMetadata } from '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
import {
  cleanupIncompleteBackends,
  getBackendDir,
  getLocalInstalledBackends,
  isBackendInstalled,
  loadCatalog,
} from '../backend'
import * as coreRuntime from '../adapter/coreRuntime'
import { AIEngine, events, fs, getJanDataFolderPath, joinPath } from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { basename } from '@tauri-apps/api/path'
import SETTINGS_JSON from '../../settings.json'

global.fetch = vi.fn()

vi.mock('@tauri-apps/plugin-log', () => ({
  info: vi.fn(),
  warn: vi.fn(),
  error: vi.fn(),
}))

vi.mock('../backend', async () => {
  // Pure helpers the tested logic reasons *with*: stubbing them would make the
  // tests assert against a mock instead of the real rules.
  const {
    friendlyBackendLabel,
    mergeBackendOptions,
    parsePrismArchiveName,
    parseVersionBackendSetting,
    prismTagBuild,
  } = await vi.importActual<typeof import('../backend')>('../backend')

  return {
    isBackendInstalled: vi.fn(),
    loadCatalog: vi.fn(),
    getBackendDir: vi.fn(),
    getLocalInstalledBackends: vi.fn(),
    cleanupIncompleteBackends: vi.fn().mockResolvedValue([]),
    friendlyBackendLabel,
    mergeBackendOptions,
    parsePrismArchiveName,
    parseVersionBackendSetting,
    prismTagBuild,
  }
})

// The advisor questions are the core's. Everything else on the adapter stays
// real so the tests keep exercising the `atomic_core_call` bridge.
vi.mock('../adapter/coreRuntime', async () => {
  const actual = await vi.importActual<typeof import('../adapter/coreRuntime')>(
    '../adapter/coreRuntime'
  )
  return {
    ...actual,
    getBackendCatalog: vi.fn(),
    recommendBackend: vi.fn(),
    checkBackendUpdates: vi.fn(),
  }
})

vi.mock(
  '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index',
  async () => {
    const actual = await vi.importActual<
      typeof import('../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index')
    >(
      '../../../../src-tauri/plugins/tauri-plugin-llamacpp-upstream/guest-js/index'
    )
    return { ...actual, readGgufMetadata: vi.fn() }
  }
)

const TAG = 'prism-b10754-2459f68'
const NEXT_TAG = 'prism-b10800-aabbcc1'

/** A catalog answer from the core with every field present; tests override what they read. */
const catalogOf = (
  over: Partial<coreRuntime.CoreBackendCatalog> = {}
): coreRuntime.CoreBackendCatalog => ({
  provider: 'atomic-prism',
  os_type: 'linux',
  arch_suffix: 'x64',
  hardware_source: 'probe',
  features: {},
  supported_backends: [],
  remote: [],
  installed: [],
  available: [],
  recommended: null,
  recommended_installed: null,
  latest_by_type: {},
  static_variants: [],
  source: 'manifest',
  ...over,
})

/** The settings machinery `AIEngine` provides, kept in memory. */
const stubSettings = (
  extension: atomic_prism_extension,
  initial: Record<string, unknown> = {}
) => {
  let stored = structuredClone(SETTINGS_JSON) as Array<{
    key: string
    controllerProps: { value: unknown; options?: unknown[]; recommended?: string }
  }>
  for (const item of stored) {
    if (item.key in initial) item.controllerProps.value = initial[item.key]
  }
  const registered: Array<typeof stored> = []
  Object.assign(extension, {
    name: '@janhq/atomic-prism-extension',
    getSettings: vi.fn(async () => structuredClone(stored)),
    updateSettings: vi.fn(async (next: typeof stored) => {
      stored = structuredClone(next)
    }),
    getSetting: vi.fn(
      async (key: string, fallback: unknown) =>
        stored.find((s) => s.key === key)?.controllerProps.value ?? fallback
    ),
    registerSettings: vi.fn(async (settings: typeof stored) => {
      registered.push(structuredClone(settings))
    }),
  })
  return {
    registered,
    value: (key: string) => stored.find((s) => s.key === key)?.controllerProps.value,
  }
}

const joinAll = () =>
  vi.mocked(joinPath).mockImplementation((paths: string[]) =>
    Promise.resolve(paths.join('/'))
  )

describe('atomic_prism_extension', () => {
  let extension: atomic_prism_extension

  beforeEach(() => {
    vi.clearAllMocks()
    vi.stubGlobal('SETTINGS', SETTINGS_JSON)
    vi.stubGlobal('IS_MAC', false)
    vi.mocked(invoke).mockImplementation(async () => undefined)
    vi.mocked(readGgufMetadata).mockResolvedValue({
      version: 3,
      tensor_count: 1,
      metadata: { 'general.architecture': 'bonsai' },
    } as any)
    vi.mocked(getJanDataFolderPath).mockResolvedValue('/jan')
    joinAll()
    extension = new atomic_prism_extension()
  })

  afterEach(() => {
    vi.restoreAllMocks()
  })

  describe('identity', () => {
    it('is the atomic-prism provider', () => {
      expect(extension.provider).toBe('atomic-prism')
      expect(extension.providerId).toBe('atomic-prism')
    })

    it('keeps backends in its own tree and models in the shared one', async () => {
      await expect(extension.getProviderPath()).resolves.toBe('/jan/atomic-prism')
      await expect(extension.getModelsRootPath()).resolves.toBe('/jan/llamacpp/models')
    })

    it('has no embedding entry point', () => {
      expect((extension as unknown as { embed?: unknown }).embed).toBeUndefined()
    })
  })

  describe('list', () => {
    const modelsDir = '/jan/llamacpp/models'
    const tree = (configs: Record<string, Record<string, unknown>>) => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) =>
        path === modelsDir ||
        Object.keys(configs).some((id) => path === `${modelsDir}/${id}/model.yml`)
      )
      vi.mocked(fs.readdirSync).mockImplementation(async (path: string) =>
        path === modelsDir ? ['bonsai', 'plain', 'turbo'] : []
      )
      vi.mocked(fs.fileStat).mockResolvedValue({ isDirectory: true, size: 1 } as any)
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        if (command !== 'read_yaml') return undefined
        const path = String((args as { path: string }).path)
        const id = Object.keys(configs).find((key) => path.includes(`/${key}/`))
        return id ? configs[id] : undefined
      })
    }

    it('keeps only the models the core set up for PrismML', async () => {
      tree({
        bonsai: {
          model_path: 'llamacpp/models/bonsai/model.gguf',
          name: 'Bonsai 8B',
          size_bytes: 1234,
          atomic_runtime: { provider: 'atomic-prism', family: 'bonsai' },
        },
        plain: { model_path: 'llamacpp/models/plain/model.gguf', name: 'Plain' },
        turbo: {
          model_path: 'llamacpp/models/turbo/model.gguf',
          name: 'Turbo',
          atomic_runtime: { provider: 'llamacpp' },
        },
      })

      const result = await extension.list()

      expect(result).toHaveLength(1)
      expect(result[0]).toMatchObject({
        id: 'bonsai',
        name: 'Bonsai 8B',
        providerId: 'atomic-prism',
        sizeBytes: 1234,
      })
      expect((result[0] as { embedding?: unknown }).embedding).toBeUndefined()
    })

    it('marks a vision projector, and caches the verdict in model.yml', async () => {
      tree({
        bonsai: {
          model_path: 'llamacpp/models/bonsai/model.gguf',
          mmproj_path: 'llamacpp/models/bonsai/mmproj.gguf',
          atomic_runtime: { provider: 'atomic-prism' },
        },
      })
      vi.mocked(readGgufMetadata).mockResolvedValue({
        version: 3,
        tensor_count: 1,
        metadata: { 'clip.has_vision_encoder': 'true' },
      } as any)

      const [model] = await extension.list()

      expect(model.capabilities).toEqual(['vision'])
      const written = vi
        .mocked(invoke)
        .mock.calls.find(([command]) => command === 'write_yaml')?.[1] as {
        data: Record<string, unknown>
      }
      expect(written.data).toMatchObject({ projector_vision: true })
    })

    it('lists nothing when the shared tree has no PrismML model', async () => {
      tree({ plain: { model_path: 'llamacpp/models/plain/model.gguf' } })
      await expect(extension.list()).resolves.toEqual([])
    })
  })

  describe('get', () => {
    it('answers for a PrismML model and not for anyone else’s', async () => {
      vi.mocked(fs.existsSync).mockResolvedValue(true)
      vi.mocked(invoke).mockImplementation(async (_command, args) =>
        String((args as { path: string }).path).includes('/bonsai/')
          ? { name: 'Bonsai', atomic_runtime: { provider: 'atomic-prism' } }
          : { name: 'Plain' }
      )

      await expect(extension.get('bonsai')).resolves.toMatchObject({
        id: 'bonsai',
        providerId: 'atomic-prism',
      })
      await expect(extension.get('plain')).resolves.toBeUndefined()
    })

    it('is undefined when the model has no model.yml', async () => {
      vi.mocked(fs.existsSync).mockResolvedValue(false)
      await expect(extension.get('nope')).resolves.toBeUndefined()
    })
  })

  describe('import', () => {
    const writtenConfig = () =>
      (
        vi.mocked(invoke).mock.calls.find(([command]) => command === 'write_yaml')?.[1] as {
          data: Record<string, unknown>
          savePath: string
        }
      )

    beforeEach(() => {
      vi.mocked(fs.fileStat).mockResolvedValue({ size: 1000 } as any)
      vi.mocked(fs.mkdir).mockResolvedValue(undefined)
    })

    it('marks a local file for this provider in model.yml', async () => {
      vi.mocked(fs.existsSync).mockImplementation(
        async (path: string) => path === '/downloads/bonsai.gguf'
      )

      await extension.import('bonsai-8b', { modelPath: '/downloads/bonsai.gguf' })

      const written = writtenConfig()
      expect(written.savePath).toBe('/jan/llamacpp/models/bonsai-8b/model.yml')
      expect(written.data).toMatchObject({
        model_path: '/downloads/bonsai.gguf',
        name: 'bonsai-8b',
        atomic_runtime: { provider: 'atomic-prism' },
      })
      expect(written.data).not.toHaveProperty('embedding')
      expect(events.emit).toHaveBeenCalledWith(
        'onModelImported',
        expect.objectContaining({ modelId: 'bonsai-8b', provider: 'atomic-prism' })
      )
    })

    it('downloads a URL through the download extension and marks it too', async () => {
      const downloadFiles = vi.fn().mockResolvedValue(undefined)
      window.core.extensionManager.getByName = vi.fn().mockReturnValue({ downloadFiles })
      vi.mocked(fs.existsSync).mockResolvedValue(false)

      await extension.import('prism-ml/bonsai', {
        modelPath: 'https://huggingface.co/prism-ml/Bonsai-GGUF/resolve/main/bonsai.gguf',
        mmprojPath: 'https://huggingface.co/prism-ml/Bonsai-GGUF/resolve/main/mmproj.gguf',
      })

      const [items, taskId] = downloadFiles.mock.calls[0]
      expect(taskId).toBe('atomic-prism/prism-ml/bonsai')
      expect(items.map((i: { save_path: string }) => i.save_path)).toEqual([
        'llamacpp/models/prism-ml/bonsai/model.gguf',
        'llamacpp/models/prism-ml/bonsai/mmproj.gguf',
      ])
      expect(writtenConfig().data).toMatchObject({
        model_path: 'llamacpp/models/prism-ml/bonsai/model.gguf',
        mmproj_path: 'llamacpp/models/prism-ml/bonsai/mmproj.gguf',
        atomic_runtime: { provider: 'atomic-prism' },
      })
    })

    it('refuses an id that escapes the models tree', async () => {
      await expect(
        extension.import('a/../b', { modelPath: '/x.gguf' })
      ).rejects.toThrow('Invalid modelId')
    })

    it('refuses a model that already exists', async () => {
      vi.mocked(fs.existsSync).mockResolvedValue(true)
      await expect(
        extension.import('bonsai', { modelPath: '/x.gguf' })
      ).rejects.toThrow('Model bonsai already exists')
    })

    it('writes nothing when the file is not a GGUF', async () => {
      vi.mocked(fs.existsSync).mockImplementation(async (path: string) => path === '/x.gguf')
      vi.mocked(readGgufMetadata).mockRejectedValue(new Error('bad magic'))
      await expect(
        extension.import('bonsai', { modelPath: '/x.gguf' })
      ).rejects.toThrow('Invalid GGUF file(s): bad magic')
      expect(writtenConfig()).toBeUndefined()
    })
  })

  describe('load, cancel and unload', () => {
    it('loads through the core under atomic-prism, never as an embedding', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      const session = { model_id: 'org/bonsai', pid: 1, port: 3000, api_key: 'k' }
      vi.mocked(invoke).mockImplementation(async (command) =>
        command === 'atomic_core_call' ? { session, created: true } : undefined
      )

      const result = await extension.load('org/bonsai', { ctx_size: 4096 } as any, true, true)

      expect(result).toEqual(session)
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/atomic-prism/org/bonsai/load',
        body: {
          overrides: { ctx_size: 4096 },
          isEmbedding: false,
          bypassAutoUnload: true,
        },
      })
    })

    it('imports the settings before the first load', async () => {
      const order: string[] = []
      extension['coreSettings'] = {
        ensureReady: vi.fn(async () => {
          order.push('ready')
        }),
        mirror: vi.fn(),
      } as any
      vi.mocked(invoke).mockImplementation(async (command) => {
        order.push(command)
        return command === 'atomic_core_call'
          ? { session: { model_id: 'm', pid: 1, port: 2, api_key: 'k' }, created: true }
          : undefined
      })

      await extension.load('m')

      expect(order).toEqual(['ready', 'atomic_core_call'])
    })

    it('reports a core refusal as a readable error that keeps its code', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      vi.mocked(invoke).mockRejectedValue({
        code: 'MODEL_LOAD_CANCELLED',
        message: 'The model load was cancelled.',
      })
      await expect(extension.load('m')).rejects.toMatchObject({
        code: 'MODEL_LOAD_CANCELLED',
      })
    })

    it('cancels a load in flight through the core', async () => {
      extension['ensureCoreIsReady'] = vi.fn().mockResolvedValue(undefined)
      let rejectLoad!: (error: unknown) => void
      vi.mocked(invoke).mockImplementation(async (command, args) => {
        const { path } = args as { path: string }
        if (command === 'atomic_core_call' && path.endsWith('/load/cancel')) {
          rejectLoad({ code: 'MODEL_LOAD_CANCELLED', message: 'cancelled' })
          return { cancelled: true }
        }
        if (command === 'atomic_core_call' && path.endsWith('/load'))
          return new Promise((_, reject) => (rejectLoad = reject))
        return undefined
      })
      const load = extension.load('m')
      load.catch(() => {})
      await new Promise((resolve) => setTimeout(resolve, 0))

      expect(await extension.cancelLoad('m')).toBe(true)
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/atomic-prism/m/load/cancel',
        body: null,
      })
      await expect(load).rejects.toMatchObject({ code: 'MODEL_LOAD_CANCELLED' })
    })

    it('unloads through the core under atomic-prism', async () => {
      vi.mocked(invoke).mockResolvedValue({ success: true })
      await expect(extension.unload('org/bonsai')).resolves.toEqual({ success: true })
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/models/atomic-prism/org/bonsai/unload',
        body: null,
      })
    })

    it('turns a failed unload into an unsuccessful result', async () => {
      vi.mocked(invoke).mockRejectedValue({ code: 'CORE_NOT_RUNNING', message: 'gone' })
      await expect(extension.unload('m')).resolves.toEqual({
        success: false,
        error: 'Failed to unload model: gone [CORE_NOT_RUNNING]',
      })
    })
  })

  describe('visibility', () => {
    it('stays hidden, and unconfirmed, until the core answers', () => {
      expect(extension.isHidden()).toBe(true)
      expect(extension.visibilityKnown()).toBe(false)
    })

    it('shows the provider where PrismML publishes a build for this machine', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({ supported_backends: ['linux-cpu-x64', 'linux-vulkan-x64'] })
      )

      await expect(extension.refreshVisibility()).resolves.toBe(true)

      expect(extension.isHidden()).toBe(false)
      expect(extension.visibilityKnown()).toBe(true)
    })

    it('hides it where there is none: Linux and Windows on Arm', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({ os_type: 'windows', arch_suffix: 'arm64', supported_backends: [] })
      )

      await expect(extension.refreshVisibility()).resolves.toBe(false)

      expect(extension.isHidden()).toBe(true)
      expect(extension.visibilityKnown()).toBe(true)
    })

    it('keeps the last answer when the core cannot be reached', async () => {
      vi.mocked(loadCatalog).mockResolvedValueOnce(
        catalogOf({ supported_backends: ['macos-arm64'] })
      )
      await extension.refreshVisibility()
      vi.mocked(loadCatalog).mockRejectedValueOnce(new Error('core restarting'))

      await expect(extension.refreshVisibility()).resolves.toBe(true)
      expect(extension.isHidden()).toBe(false)
    })

    it('asks the core once for callers that come while a check runs', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({ supported_backends: ['macos-arm64'] })
      )

      const answers = await Promise.all([
        extension.refreshVisibility(),
        extension.refreshVisibility(),
      ])

      expect(answers).toEqual([true, true])
      expect(vi.mocked(loadCatalog).mock.calls).toHaveLength(1)
    })
  })

  describe('getEngineStatus', () => {
    it('is not installed, with the build the core recommends for this machine', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({
          supported_backends: ['macos-arm64'],
          available: [{ version: TAG, backend: 'macos-arm64', order: 1 }],
          recommended: `${TAG}/macos-arm64`,
        })
      )

      await expect(extension.getEngineStatus()).resolves.toEqual({
        installed: false,
        recommended: `${TAG}/macos-arm64`,
      })
      // The packs are listed again, so an install that just finished counts.
      expect(vi.mocked(loadCatalog).mock.calls[0][0]).toMatchObject({ refresh: true })
    })

    it('falls back to the best available build when the core names none', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({
          supported_backends: ['linux-cpu-x64', 'linux-vulkan-x64'],
          available: [
            { version: TAG, backend: 'linux-cpu-x64', order: 1 },
            { version: TAG, backend: 'linux-vulkan-x64', order: 2 },
          ],
        })
      )

      const status = await extension.getEngineStatus()

      expect(status.recommended).toBe(`${TAG}/linux-vulkan-x64`)
    })

    it('offers nothing when only unverified builds exist and they are not allowed', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({ supported_backends: ['macos-arm64'], available: [] })
      )

      await expect(extension.getEngineStatus()).resolves.toEqual({
        installed: false,
        recommended: null,
      })
    })

    it('is installed once the core lists a pack on disk', async () => {
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({
          supported_backends: ['macos-arm64'],
          installed: [{ version: TAG, backend: 'macos-arm64' }],
        })
      )

      const status = await extension.getEngineStatus()

      expect(status.installed).toBe(true)
      expect(extension.isHidden()).toBe(false)
    })
  })

  describe('allow_candidate_builds', () => {
    const watchCoreHandOff = () => {
      const order: string[] = []
      extension['coreSettings'] = {
        ensureReady: vi.fn(async () => {
          order.push('import')
        }),
        mirror: vi.fn(),
      } as any
      vi.spyOn(extension, 'configureBackends').mockImplementation(async () => {
        order.push('catalog')
      })
      return order
    }

    it('imports a change into the core, then rebuilds the version list from the new catalog', async () => {
      const order = watchCoreHandOff()
      extension['isInitializing'] = false
      extension['config'] = { allow_candidate_builds: false } as any

      extension.onSettingUpdate('allow_candidate_builds', true)

      await vi.waitFor(() => expect(order).toEqual(['import', 'catalog']))
      expect(extension['config'].allow_candidate_builds).toBe(true)
    })

    it('does nothing for a save that leaves it as it was', async () => {
      const order = watchCoreHandOff()
      extension['isInitializing'] = false
      extension['config'] = { allow_candidate_builds: true } as any

      extension.onSettingUpdate('allow_candidate_builds', true)
      await Promise.resolve()

      expect(order).toEqual([])
    })

    it('leaves the first catalog to the start-up pass', async () => {
      const order = watchCoreHandOff()
      extension['isInitializing'] = true
      extension['config'] = { allow_candidate_builds: false } as any

      extension.onSettingUpdate('allow_candidate_builds', true)
      await Promise.resolve()

      expect(order).toEqual([])
    })
  })

  describe('configureBackends', () => {
    it('leaves version_backend at none with no catalog and nothing installed', async () => {
      const settings = stubSettings(extension)
      extension['config'] = { version_backend: 'none' } as any
      vi.mocked(loadCatalog).mockRejectedValue(new Error('core unreachable'))
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([])
      vi.mocked(isBackendInstalled).mockResolvedValue(false)

      await extension.configureBackends()

      expect(extension['config'].version_backend).toBe('none')
      expect(settings.value('version_backend')).toBe('none')
      const vb = settings.registered.at(-1)!.find((s) => s.key === 'version_backend')!
      expect(vb.controllerProps.options).toEqual([])
      expect(extension.updateSettings).not.toHaveBeenCalled()
    })

    it('offers the installed packs when the core has no catalog', async () => {
      const settings = stubSettings(extension)
      extension['config'] = { version_backend: 'none' } as any
      vi.mocked(loadCatalog).mockRejectedValue(new Error('core unreachable'))
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([
        { version: TAG, backend: 'linux-vulkan-x64' },
      ])
      vi.mocked(isBackendInstalled).mockResolvedValue(true)

      await extension.configureBackends()

      expect(extension['config'].version_backend).toBe(`${TAG}/linux-vulkan-x64`)
      expect(settings.value('version_backend')).toBe(`${TAG}/linux-vulkan-x64`)
    })

    it('takes the core recommendation on a fresh install, with the catalog as options', async () => {
      const settings = stubSettings(extension)
      extension['config'] = { version_backend: 'none' } as any
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({
          available: [
            { version: TAG, backend: 'linux-cuda-12.4-x64', order: 2 },
            { version: TAG, backend: 'linux-cpu-x64', order: 1 },
          ],
          recommended: `${TAG}/linux-cuda-12.4-x64`,
          latest_by_type: {
            'linux-cuda-12.4-x64': `${TAG}/linux-cuda-12.4-x64`,
            'linux-cpu-x64': `${TAG}/linux-cpu-x64`,
          },
        })
      )
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([])
      vi.mocked(isBackendInstalled).mockResolvedValue(false)

      await extension.configureBackends()

      expect(extension['config'].version_backend).toBe(`${TAG}/linux-cuda-12.4-x64`)
      const vb = settings.registered.at(-1)!.find((s) => s.key === 'version_backend')!
      expect(vb.controllerProps.options).toEqual([
        { value: `${TAG}/linux-cuda-12.4-x64`, name: `${TAG}/linux-cuda-12.4-x64` },
        { value: `${TAG}/linux-cpu-x64`, name: `${TAG}/linux-cpu-x64` },
      ])
      expect(vb.controllerProps.recommended).toBe(`${TAG}/linux-cuda-12.4-x64`)
      // Nothing is downloaded from here: the core fetches the pack at the first load.
      expect(invoke).not.toHaveBeenCalledWith(
        'atomic_core_call',
        expect.objectContaining({ path: '/backends/atomic-prism/install' })
      )
    })

    it('recovers the build on disk when the settings were lost', async () => {
      stubSettings(extension)
      extension['config'] = { version_backend: '' } as any
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({
          available: [{ version: TAG, backend: 'macos-arm64' }],
          recommended_installed: `${TAG}/macos-arm64`,
          latest_by_type: { 'macos-arm64': `${TAG}/macos-arm64` },
        })
      )
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([
        { version: TAG, backend: 'macos-arm64' },
      ])
      vi.mocked(isBackendInstalled).mockResolvedValue(true)

      await extension.configureBackends()

      expect(extension['config'].version_backend).toBe(`${TAG}/macos-arm64`)
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'atomic_prism_backend_type',
        'macos-arm64'
      )
    })

    it('keeps a saved build the catalog no longer lists while it is installed', async () => {
      const settings = stubSettings(extension, {
        version_backend: `${TAG}/linux-rocm-7.2-x64`,
      })
      extension['config'] = { version_backend: `${TAG}/linux-rocm-7.2-x64` } as any
      vi.mocked(loadCatalog).mockResolvedValue(
        catalogOf({
          available: [{ version: NEXT_TAG, backend: 'linux-cpu-x64' }],
          recommended: `${NEXT_TAG}/linux-cpu-x64`,
        })
      )
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([])
      vi.mocked(isBackendInstalled).mockResolvedValue(true)

      await extension.configureBackends()

      expect(extension['config'].version_backend).toBe(`${TAG}/linux-rocm-7.2-x64`)
      const vb = settings.registered.at(-1)!.find((s) => s.key === 'version_backend')!
      expect(vb.controllerProps.options).toContainEqual({
        value: `${TAG}/linux-rocm-7.2-x64`,
        name: `${TAG}/linux-rocm-7.2-x64`,
      })
    })
  })

  // Engine update offers are the desktop's, from the core's `POST /engines/versions`
  // (change unify-engine-lifecycle): the extension neither checks on load nor publishes one.
  describe('update offer', () => {
    it('makes none of its own', () => {
      expect('reconcileBackendReleaseTag' in extension).toBe(false)
      expect('offerEngineUpdate' in extension).toBe(false)
    })
  })

  describe('checkBackendForUpdates', () => {
    it('reads the PrismML fields defensively', async () => {
      extension['config'] = { version_backend: `${TAG}/linux-cpu-x64` } as any
      vi.mocked(coreRuntime.checkBackendUpdates).mockResolvedValue({
        update_needed: true,
        new_version: NEXT_TAG,
        target_backend: `${NEXT_TAG}/linux-cpu-x64`,
        same_family: true,
        notes_url: 42,
        notes: '',
        download_size: -1,
        current_withdrawn: {},
      } as any)

      const result = await extension.checkBackendForUpdates({ force: true })

      expect(result).toEqual({
        updateNeeded: true,
        newVersion: NEXT_TAG,
        targetBackend: `${NEXT_TAG}/linux-cpu-x64`,
        sameFamily: true,
        reason: undefined,
        notesUrl: undefined,
        notes: undefined,
        downloadSize: undefined,
        currentWithdrawn: 'withdrawn',
      })
      expect(coreRuntime.checkBackendUpdates).toHaveBeenCalledWith(
        expect.objectContaining({ current: `${TAG}/linux-cpu-x64`, force: true })
      )
    })

    it('answers "no update" without asking for a malformed backend', async () => {
      extension['config'] = { version_backend: 'none' } as any
      await expect(extension.checkBackendForUpdates()).resolves.toEqual({
        updateNeeded: false,
        newVersion: '0',
        sameFamily: false,
      })
      expect(coreRuntime.checkBackendUpdates).not.toHaveBeenCalled()
    })

    it('answers "no update" when the core fails', async () => {
      extension['config'] = { version_backend: `${TAG}/linux-cpu-x64` } as any
      vi.mocked(coreRuntime.checkBackendUpdates).mockRejectedValue(new Error('down'))
      await expect(extension.checkBackendForUpdates()).resolves.toMatchObject({
        updateNeeded: false,
      })
    })

    it('feeds the manual check, which only decides', async () => {
      extension['config'] = { version_backend: `${TAG}/linux-cpu-x64` } as any
      vi.mocked(coreRuntime.checkBackendUpdates).mockResolvedValue({
        update_needed: true,
        new_version: NEXT_TAG,
        target_backend: `${NEXT_TAG}/linux-cpu-x64`,
        same_family: true,
      } as any)

      await expect(extension.checkForEngineUpdate()).resolves.toEqual({
        updateAvailable: true,
        targetBackend: `${NEXT_TAG}/linux-cpu-x64`,
      })
      expect(invoke).not.toHaveBeenCalledWith(
        'atomic_core_call',
        expect.objectContaining({ path: '/backends/atomic-prism/install' })
      )
    })
  })

  describe('backends', () => {
    it('downloads a pack through the core under the backend task id', async () => {
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(listen).mockResolvedValue(vi.fn())
      vi.mocked(invoke).mockResolvedValue({ installed: true })

      await extension['downloadAndInstallBackend'](`${TAG}/linux-cuda-12.4-x64`)

      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'POST',
        path: '/backends/atomic-prism/install',
        body: {
          version: TAG,
          backend: 'linux-cuda-12.4-x64',
          task_id: 'llamacpp-backend-prism-b10754-2459f68/linux-cuda-12_4-x64',
          force: false,
          proxy: null,
        },
      })
      expect(events.emit).toHaveBeenCalledWith(
        'onBackendDownloadFinished',
        expect.objectContaining({ status: 'completed', provider: 'atomic-prism' })
      )
    })

    it('refuses an unresolved latest tag before it reaches the core', async () => {
      await expect(
        extension['downloadAndInstallBackend']('latest/linux-cpu-x64')
      ).rejects.toMatchObject({ code: 'BACKEND_TAG_UNRESOLVED' })
      expect(invoke).not.toHaveBeenCalled()
    })

    // Change unify-engine-lifecycle: the core installs, switches and retires old builds; the
    // extension writes no version and removes nothing.
    it('has the core switch to the build a `latest/` pick resolves to', async () => {
      extension['config'] = { version_backend: `${TAG}/linux-cpu-x64` } as any
      extension['resolveLatestBackendString'] = vi
        .fn()
        .mockResolvedValue(`${NEXT_TAG}/linux-cpu-x64`)
      vi.mocked(listen).mockResolvedValue(vi.fn())
      vi.mocked(invoke).mockResolvedValue({
        updated: true,
        active: { version: NEXT_TAG, variant: 'linux-cpu-x64' },
        retired: [{ version: TAG, variant: 'linux-cpu-x64' }],
        kept_in_use: [],
      })

      await extension['switchThroughCore']('latest/linux-cpu-x64')

      expect(vi.mocked(invoke).mock.calls).toEqual([
        [
          'atomic_core_call',
          {
            method: 'POST',
            path: '/engines/atomic-prism/update',
            body: {
              task_id: 'engine-update-atomic-prism-latest_linux-cpu-x64',
              target: { version: NEXT_TAG, variant: 'linux-cpu-x64' },
            },
          },
        ],
      ])
      expect(extension['config'].version_backend).toBe(`${TAG}/linux-cpu-x64`)
    })

    it('resolves a pick it can neither find in the catalog nor on disk to an actionable error', async () => {
      extension['resolveLatestBackendString'] = vi.fn().mockResolvedValue(null)
      extension['newestInstalledOfFamily'] = vi.fn().mockResolvedValue(null)

      await expect(
        extension.resolveBackendSelection('latest/linux-rocm-7.2-x64')
      ).rejects.toThrow(/Install backend from file/)
      await expect(
        extension.resolveBackendSelection(`${TAG}/linux-cpu-x64`)
      ).resolves.toBe(`${TAG}/linux-cpu-x64`)
    })

    it('installs an archive from a file under the id the core looks it up by', async () => {
      stubSettings(extension)
      extension['config'] = { version_backend: 'none' } as any
      extension.configureBackends = vi.fn().mockResolvedValue(undefined)
      vi.mocked(basename).mockResolvedValue(`llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`)
      vi.mocked(fs.existsSync).mockResolvedValue(true)
      vi.mocked(getBackendDir).mockResolvedValue(`/jan/atomic-prism/backends/${TAG}/linux-vulkan-x64`)

      await extension.installBackend(`/dl/llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`)

      expect(getBackendDir).toHaveBeenCalledWith('linux-vulkan-x64', TAG)
      expect(invoke).toHaveBeenCalledWith('decompress', {
        path: `/dl/llama-${TAG}-bin-ubuntu-vulkan-x64.tar.gz`,
        outputDir: `/jan/atomic-prism/backends/${TAG}/linux-vulkan-x64`,
      })
      expect(extension['config'].version_backend).toBe(`${TAG}/linux-vulkan-x64`)
    })

    it('refuses an archive that is not a PrismML server build', async () => {
      vi.mocked(basename).mockResolvedValue('llama-b1-bin-macos-arm64.tar.gz')
      vi.mocked(fs.existsSync).mockResolvedValue(true)
      await expect(
        extension.installBackend('/dl/llama-b1-bin-macos-arm64.tar.gz')
      ).rejects.toThrow('Failed to parse archive name')
    })

    it('lists and removes packs through the core', async () => {
      extension['config'] = { version_backend: `${TAG}/macos-arm64` } as any
      vi.mocked(invoke).mockResolvedValue({ backends: [], removed: true })

      await extension.listInstalledBackends()
      await extension.deleteBackend(TAG, 'macos-arm64')

      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'GET',
        path: `/backends/atomic-prism?current=${encodeURIComponent(`${TAG}/macos-arm64`)}`,
        body: null,
      })
      expect(invoke).toHaveBeenCalledWith('atomic_core_call', {
        method: 'DELETE',
        path: `/backends/atomic-prism/${TAG}/macos-arm64`,
        body: null,
      })
    })

    it('stores its backend type under its own key', () => {
      extension['setStoredBackendType']('linux-cpu-x64')
      expect(localStorage.setItem).toHaveBeenCalledWith('atomic_prism_backend_type', 'linux-cpu-x64')
    })
  })

  describe('optimal backend', () => {
    const record = {
      schemaVersion: 1,
      provider: 'atomic-prism',
      detectedAt: 1,
      currentBackend: `${TAG}/linux-cpu-x64`,
      recommendedCategory: 'CUDA',
      detectionKind: 'gpu',
      idealBackendId: 'linux-cuda-12.4-x64',
      recommendedBackend: `${TAG}/linux-cuda-12.4-x64`,
    }

    it('reads its own record and nobody else’s', () => {
      vi.mocked(localStorage.getItem).mockImplementation((key) =>
        key === OPTIMAL_BACKEND_CACHE_KEY ? JSON.stringify(record) : null
      )
      expect(OPTIMAL_BACKEND_CACHE_KEY).toBe('atomic_prism_optimal_backend_v1')
      expect(extension.getCachedOptimalBackend()).toEqual(record)

      vi.mocked(localStorage.getItem).mockReturnValue(
        JSON.stringify({ ...record, provider: 'llamacpp-upstream' })
      )
      expect(extension.getCachedOptimalBackend()).toBeNull()
    })

    it('surfaces a recommendation stamped with this provider', async () => {
      vi.mocked(coreRuntime.recommendBackend).mockResolvedValue({
        provider: 'atomic-prism',
        mode: 'recheck',
        outcome: 'recommend',
        detection: { kind: 'gpu' },
        record: null,
        revision: 1,
        optimal: null,
        recommendation: {
          currentBackend: `${TAG}/linux-cpu-x64`,
          recommendedBackend: `${TAG}/linux-cuda-12.4-x64`,
          recommendedCategory: 'CUDA',
          provider: 'someone-else',
          version: TAG,
          backendId: 'linux-cuda-12.4-x64',
        },
        elapsed_ms: 1,
      } as any)
      extension['config'] = { version_backend: `${TAG}/linux-cpu-x64` } as any

      const payload = await extension.recheckOptimalBackend()

      expect(payload?.provider).toBe('atomic-prism')
      expect(events.emit).toHaveBeenCalledWith(
        'onBetterBackendDetected',
        expect.objectContaining({ provider: 'atomic-prism' })
      )
    })

    it('throws BACKEND_DETECTION_FAILED when the core could not detect', async () => {
      vi.mocked(coreRuntime.recommendBackend).mockResolvedValue({
        outcome: 'detection_failed',
      } as any)
      extension['config'] = { version_backend: `${TAG}/linux-cpu-x64` } as any
      await expect(extension.recheckOptimalBackend()).rejects.toThrow(BACKEND_DETECTION_FAILED)
    })
  })

  describe('onLoad listeners', () => {
    const listeners = new Map<string, (event: { payload: unknown }) => unknown>()

    beforeEach(() => {
      // `AIEngine` is a bare mock; its `onLoad` registers the engine, which these tests do not need.
      ;(AIEngine as unknown as { prototype: Record<string, unknown> }).prototype.onLoad = vi.fn()
      listeners.clear()
      vi.mocked(listen).mockImplementation(async (name, callback) => {
        listeners.set(name, callback as never)
        return vi.fn()
      })
      stubSettings(extension)
      vi.mocked(loadCatalog).mockRejectedValue(new Error('offline'))
      vi.mocked(getLocalInstalledBackends).mockResolvedValue([])
      vi.mocked(isBackendInstalled).mockResolvedValue(false)
      vi.mocked(cleanupIncompleteBackends).mockResolvedValue([])
      vi.mocked(localStorage.getItem).mockReturnValue(null)
    })

    it('answers only the auto-increase-ctx requests of atomic-prism', async () => {
      await extension.onLoad()
      const handle = vi.spyOn(extension as any, 'handleAutoIncreaseCtx').mockResolvedValue(undefined)
      const listener = listeners.get('local_backend://auto_increase_ctx')!

      for (const backend of ['llamacpp', 'llamacpp-upstream', 'mlx', undefined]) {
        listener({ payload: { request_id: 'r', backend, model_id: 'm', trigger: 'error' } })
      }
      expect(handle).not.toHaveBeenCalled()

      const own = { request_id: 'r', backend: 'atomic-prism', model_id: 'm', trigger: 'error' }
      listener({ payload: own })
      expect(handle).toHaveBeenCalledWith(own)
    })

    it('mirrors only its own settings changes', async () => {
      await extension.onLoad()
      const mirror = vi.fn().mockResolvedValue(undefined)
      extension['coreSettings'] = { ensureReady: vi.fn(), mirror } as any
      const listener = listeners.get('atomic-core://settings:changed')!

      listener({ payload: { provider: 'llamacpp-upstream' } })
      expect(mirror).not.toHaveBeenCalled()
      listener({ payload: { provider: 'atomic-prism' } })
      expect(mirror).toHaveBeenCalledOnce()
    })

    // Change unify-engine-lifecycle (6.3): the core writes `version_backend` on an update or an
    // activation, from this app or another client.
    it('takes a build the core switched to: adds it to the list, records its type and tells the page', async () => {
      stubSettings(extension, { version_backend: `${TAG}/linux-cpu-x64` })
      const addOption = vi
        .spyOn(extension as any, 'ensureBackendOption')
        .mockResolvedValue(undefined)
      vi.mocked(invoke).mockImplementation(async (_command, args) => {
        const { method, path } = args as { method: string; path: string }
        if (method === 'GET' && path === '/settings/atomic-prism') {
          return {
            provider: 'atomic-prism',
            revision: 4,
            values: { version_backend: `${NEXT_TAG}/linux-vulkan-x64` },
          }
        }
        return undefined
      })
      vi.mocked(events.emit).mockClear()

      await extension['coreSettings'].mirror()

      expect(addOption).toHaveBeenCalledWith(`${NEXT_TAG}/linux-vulkan-x64`)
      const stored = (await extension.getSettings()).find(
        (s: { key: string }) => s.key === 'version_backend'
      )
      expect(stored?.controllerProps.value).toBe(`${NEXT_TAG}/linux-vulkan-x64`)
      expect(events.emit).toHaveBeenCalledWith('settingsChanged', {
        key: 'version_backend',
        value: `${NEXT_TAG}/linux-vulkan-x64`,
      })
      expect(localStorage.setItem).toHaveBeenCalledWith(
        'atomic_prism_backend_type',
        'linux-vulkan-x64'
      )
    })

    it('says nothing to the page when the core’s version is the one it holds', async () => {
      stubSettings(extension, { version_backend: `${TAG}/linux-cpu-x64` })
      vi.mocked(invoke).mockImplementation(async (_command, args) => {
        const { method, path } = args as { method: string; path: string }
        if (method === 'GET' && path === '/settings/atomic-prism') {
          return {
            provider: 'atomic-prism',
            revision: 4,
            values: { version_backend: `${TAG}/linux-cpu-x64` },
          }
        }
        return undefined
      })
      vi.mocked(events.emit).mockClear()

      await extension['coreSettings'].mirror()

      expect(
        vi.mocked(events.emit).mock.calls.filter(([name]) => name === 'settingsChanged')
      ).toEqual([])
    })

    it('follows the core’s optimal-backend record for this provider only', async () => {
      await extension.onLoad()
      const listener = listeners.get('atomic-core://backend:optimal-changed')!
      vi.mocked(localStorage.setItem).mockClear()

      listener({ payload: { provider: 'llamacpp-upstream', revision: 5, optimal: {} } })
      expect(localStorage.setItem).not.toHaveBeenCalled()

      listener({ payload: { provider: 'atomic-prism', revision: 5, optimal: { a: 1 } } })
      expect(localStorage.setItem).toHaveBeenCalledWith(
        OPTIMAL_BACKEND_CACHE_KEY,
        JSON.stringify({ a: 1 })
      )
    })

    it('forgets the record when the core detaches', async () => {
      await extension.onLoad()
      listeners.get('atomic-core://detached')!({ payload: null })
      expect(localStorage.removeItem).toHaveBeenCalledWith(OPTIMAL_BACKEND_CACHE_KEY)
    })

    it('keeps the persisted build across settings registration', async () => {
      stubSettings(extension, { version_backend: `${TAG}/macos-arm64` })
      await extension.onLoad()
      const first = vi.mocked(extension.registerSettings).mock.calls[0][0] as Array<{
        key: string
        controllerProps: { value: unknown; options?: unknown[] }
      }>
      const vb = first.find((s) => s.key === 'version_backend')!
      expect(vb.controllerProps.value).toBe(`${TAG}/macos-arm64`)
      expect(vb.controllerProps.options).toEqual([
        { value: `${TAG}/macos-arm64`, name: `${TAG}/macos-arm64` },
      ])
    })
  })
})
