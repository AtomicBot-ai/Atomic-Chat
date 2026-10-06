/**
 * A managed engine as an app extension (openspec change `add-vllm-runtime`, design D14): an engine
 * `atomic-chat-core` runs in a container — on Linux in Docker, on Windows inside Atomic Chat's own
 * WSL distribution — and serves each loaded model on a loopback gateway that checks the session's
 * Bearer key:
 *
 *   extension → atomic-chat-core → session gateway → container
 *
 * The core owns the environment (Docker, the NVIDIA Container Toolkit, the engine image), every
 * load and unload, and each model's capabilities. What an engine extension always keeps is here,
 * once for every managed engine:
 *
 * - whether the provider is shown at all — the core's plan for this engine (`visibility.ts`);
 * - the model list: every folder with a `model.yml` (written last by the app's downloader) under the
 *   one root of the shared model store the core names (`GET /managed-models/location`: `<data>/
 *   managed-models` on Linux, a folder in Atomic Chat's WSL distribution on Windows). Every managed
 *   engine lists the whole store, as both llama.cpp providers list one folder; whether a model runs
 *   on an engine is decided when it loads;
 * - deleting a model through the core (`DELETE /managed-models/:id`), which takes it from every
 *   engine;
 * - the settings, handed to the core before each load.
 *
 * Shared code takes the extension's own `@janhq/core` and Tauri functions instead of importing them:
 * every extension has its own `node_modules`, and `shared/` has none. An engine's extension is
 * `class X extends managedEngineExtension(spec, deps) {}`.
 */

import type {
  chatCompletion,
  chatCompletionChunk,
  chatCompletionRequest,
  ImportOptions,
  ModelLoadOptions,
  modelInfo,
  SessionInfo,
  UnloadResult,
} from '@janhq/core'

import { createCoreRuntime, describeCoreError, isCoreError } from '../atomicCoreRuntime'
import type {
  CoreProvider,
  CoreSessionInfo,
  CoreSessionLoadProgress,
  Invoke,
} from '../atomicCoreRuntime'
import { createCoreSettingsSync } from '../atomicCoreSettingsSync'
import type { PersistedSetting } from '../atomicCoreSettingsSync'
import { LoadCancelTracker, toLoadError } from '../loadCancel'
import {
  descriptorHint,
  isProviderHidden,
  type EnvironmentView,
  type PlanVerdict,
} from './visibility'

const CORE_SETTINGS_CHANGED_EVENT = 'atomic-core://settings:changed'
/** The core's stages of a container-backed load (`CoreSessionLoadProgress`). */
const LOAD_PROGRESS_EVENT = 'atomic-core://session:load-progress'

export interface ManagedEngineSpec {
  /** The core's `engine_id`, which is the provider id (core design D3). */
  engineId: CoreProvider
  /** The engine's name in the messages a person reads. */
  label: string
  /**
   * The extension's `settings.json` (the core's settings schema for the engine), read when the
   * extension loads: the bundler's `SETTINGS` constant.
   */
  settings: () => unknown[]
}

/** The part of `@janhq/core`'s `AIEngine` this class builds on. */
interface EngineBase {
  onLoad(): void
  registerSettings(settings: unknown[]): Promise<void> | void
  getSettings(): Promise<unknown[]>
  updateSettings(settings: unknown[]): Promise<void>
}

export interface ManagedEngineDeps {
  /** `@janhq/core`'s `AIEngine`: the class every engine extension extends. */
  AIEngine: unknown
  invoke: Invoke
  listen: <T>(event: string, handler: (event: { payload?: T }) => void) => Promise<() => void>
  fs: {
    existsSync(path: string): Promise<boolean>
    readdirSync(path: string): Promise<string[]>
    fileStat(path: string): Promise<{ isDirectory?: boolean } | undefined | null>
  }
  joinPath(parts: string[]): Promise<string>
  getJanDataFolderPath(): Promise<string>
  log: {
    info(message: string): unknown
    warn(message: string): unknown
    error(message: string): unknown
  }
}

/** `model.yml` as the app's downloader writes it (the core's store schema). */
interface ManagedModelYml {
  repository?: string | null
  revision?: string | null
  architectures?: string[]
  files?: Array<{ path: string; size: number; sha256?: string | null }>
}

/** What `DELETE /managed-models/:id` answers (`ManagedModelDeletion`). */
interface ManagedModelDeletion {
  model_id: string
  was_loaded: boolean
  freed_bytes: number
  engine_caches_removed: number
}

export function managedEngineExtension(spec: ManagedEngineSpec, deps: ManagedEngineDeps) {
  const { engineId, label } = spec
  const tag = `[${engineId}]`

  const logger = {
    info: (message: string) => {
      console.log(message)
      deps.log.info(message)
    },
    warn: (message: string) => {
      console.warn(message)
      deps.log.warn(message)
    },
    error: (message: string) => {
      console.error(message)
      deps.log.error(message)
    },
  }

  /**
   * A refused deletion as an `Error` the app can show as it is, keeping the core's `code`. The two
   * refusals a person can meet get their own words: the model would not stop (nothing was deleted),
   * and the model is not there (never read as a success, design D12a).
   */
  function deletionError(modelId: string, error: unknown): Error & { code?: string } {
    const code = isCoreError(error) ? error.code : undefined
    const message =
      code === 'MANAGED_STOP_UNCONFIRMED'
        ? `${label} could not stop ${modelId}, so its files were not touched. Try again, or check Docker.`
        : code === 'MODEL_NOT_FOUND'
          ? `${label} has no model ${modelId}. It may have been deleted already.`
          : `${label} could not delete ${modelId}: ${describeCoreError(error)}`
    return Object.assign(new Error(message), { code })
  }

  const Base = deps.AIEngine as new (...args: unknown[]) => EngineBase

  return class ManagedEngineExtension extends Base {
    readonly provider: string = engineId
    readonly providerId: string = engineId

    /** Seconds before a streaming chat request is considered timed out. */
    timeout: number = 600

    private readonly core = createCoreRuntime(engineId, ((command, args) =>
      args === undefined ? deps.invoke(command) : deps.invoke(command, args)) as Invoke)
    private readonly loadCancel = new LoadCancelTracker(this.core, (message) => logger.warn(message))
    private readonly coreSettings = createCoreSettingsSync({
      core: this.core,
      readSettings: async () => (await this.getSettings()) as unknown as PersistedSetting[],
      writeSettings: (settings) => this.updateSettings(settings as never),
      setMirroring: () => {},
    })
    private unlistenCoreSettingsChanged?: () => void
    private providerPath?: string
    /** The store root the core named last; `null` once it said there is none. */
    private modelsRoot?: string | null
    /** Hidden until the core says otherwise: a provider that cannot run here must not flash up. */
    private hidden = true
    /** Whether `hidden` is the core's answer, or only the default nobody has confirmed yet. */
    private known = false
    /** The probe in flight, shared by every caller that asks while it runs. */
    private visibilityCheck?: Promise<boolean>

    override async onLoad(): Promise<void> {
      super.onLoad()
      this.registerSettings(structuredClone(spec.settings()))
      this.unlistenCoreSettingsChanged = await deps.listen<{ provider?: string }>(
        CORE_SETTINGS_CHANGED_EVENT,
        (event) => {
          if (event.payload?.provider !== this.provider) return
          void this.coreSettings
            .mirror()
            .catch((e) => logger.warn(`[atomic-core] could not mirror changed settings: ${describeCoreError(e)}`))
        }
      )
      // Not awaited: every extension's onLoad holds the UI back, and a probe runs docker info,
      // nvidia-smi and a descriptor fetch. The app's DataProvider waits for this same probe and then
      // updates the provider list.
      void this.refreshVisibility()
    }

    async onUnload(): Promise<void> {
      this.unlistenCoreSettingsChanged?.()
      this.unlistenCoreSettingsChanged = undefined
      // Containers belong to the core; there is nothing to stop here.
    }

    // ── Visibility ───────────────────────────────────────────────────────────

    /** Whether the provider stays out of the app's lists, as of the last {@link refreshVisibility}. */
    isHidden(): boolean {
      return this.hidden
    }

    /**
     * Whether the core has answered at least once. A probe that fails keeps the last answer; before
     * any answer the provider stays hidden, but that is not a reason to forget it.
     */
    visibilityKnown(): boolean {
      return this.known
    }

    /**
     * Ask the core again whether this machine can run or set up the engine; `true` when the provider
     * should be shown. Probing changes nothing on the machine. Called when the extension loads and
     * whenever the provider settings open, so a descriptor published in conf shows the provider
     * without an app update. A core that cannot answer hides it, as it would any engine it cannot
     * run. A call made while a probe runs waits for that probe rather than starting another.
     */
    refreshVisibility(): Promise<boolean> {
      this.visibilityCheck ??= this.probeVisibility().finally(() => {
        this.visibilityCheck = undefined
      })
      return this.visibilityCheck
    }

    private async probeVisibility(): Promise<boolean> {
      try {
        const { environments } = await this.coreCall<{ environments: EnvironmentView[] }>(
          'GET',
          '/environments'
        )
        const plan = await this.coreCall<PlanVerdict>('POST', '/environments/probe', {
          descriptor_id: descriptorHint(environments ?? [], engineId),
          target: { kind: 'runtime', installation_id: engineId, engine_id: engineId },
        })
        this.hidden = isProviderHidden(plan)
        this.known = true
      } catch (e) {
        // A core restarting or unreachable says nothing about the machine: keep the last answer.
        logger.warn(`${label} availability could not be checked: ${describeCoreError(e)}`)
      }
      return !this.hidden
    }

    // ── Model catalogue ──────────────────────────────────────────────────────

    async getProviderPath(): Promise<string> {
      if (!this.providerPath) {
        this.providerPath = await deps.joinPath([await deps.getJanDataFolderPath(), engineId])
      }
      return this.providerPath
    }

    /**
     * The root of the shared model store (`GET /managed-models/location`), spelled as the app's own
     * path calls spell it. `null` where the core names none: on Windows before Atomic Chat's
     * distribution is imported, or where no managed provider is offered. A core that cannot answer
     * right now (restarting, not attached yet) leaves the root it named last: that says nothing
     * about where the models are, and must not make them vanish.
     */
    private async modelsDir(): Promise<string | null> {
      try {
        const { root } = await this.coreCall<{ root: string; free_bytes: number | null }>(
          'GET',
          '/managed-models/location'
        )
        this.modelsRoot = await deps.joinPath([root])
        return this.modelsRoot
      } catch (e) {
        const code = isCoreError(e) ? e.code : undefined
        if (code === 'MANAGED_ADAPTER_UNAVAILABLE' || code === 'PROVIDER_NOT_FOUND') {
          this.modelsRoot = null
        } else {
          logger.warn(`${label} models root not reported now, using the last one: ${describeCoreError(e)}`)
        }
        return this.modelsRoot ?? null
      }
    }

    /**
     * Every folder under the store root holding a `model.yml`, found the way the core finds them: a
     * folder with one is a model and is not descended into, a folder without one (a download in
     * progress) is not a model. The id is the folder's path under the root.
     */
    async list(): Promise<modelInfo[]> {
      const modelsDir = await this.modelsDir()
      if (modelsDir === null || !(await deps.fs.existsSync(modelsDir))) return []

      const ids: string[] = []
      const stack = [modelsDir]
      while (stack.length > 0) {
        const dir = stack.pop() as string
        if (dir !== modelsDir && (await deps.fs.existsSync(await deps.joinPath([dir, 'model.yml'])))) {
          ids.push(dir.slice(modelsDir.length + 1).replace(/\\/g, '/'))
          continue
        }
        for (const child of await deps.fs.readdirSync(dir)) {
          if ((await deps.fs.fileStat(child))?.isDirectory) stack.push(child)
        }
      }

      const models: modelInfo[] = []
      for (const id of ids) {
        try {
          models.push(await this.describe(id, modelsDir))
        } catch (e) {
          logger.warn(`Skipping ${label} model ${id}: ${describeCoreError(e)}`)
        }
      }
      return models
    }

    async get(modelId: string): Promise<modelInfo | undefined> {
      // The folder `list()` found is reused: a lookup per model is not a core call each.
      const modelsDir = this.modelsRoot !== undefined ? this.modelsRoot : await this.modelsDir()
      if (modelsDir === null) return undefined
      try {
        return await this.describe(modelId, modelsDir)
      } catch {
        return undefined
      }
    }

    private async describe(id: string, modelsDir: string): Promise<modelInfo> {
      const yml = await deps.invoke<ManagedModelYml>('read_yaml', {
        path: await deps.joinPath([modelsDir, id, 'model.yml']),
      })
      const capabilities = (await this.isToolSupported(id)) ? ['tools'] : []
      return {
        id,
        name: yml.repository ?? id,
        providerId: this.provider,
        port: 0,
        sizeBytes: (yml.files ?? []).reduce((total, file) => total + (file.size ?? 0), 0),
        path: await deps.joinPath([modelsDir, id]),
        capabilities: capabilities.length > 0 ? capabilities : undefined,
      } as modelInfo
    }

    /**
     * Whether the model calls tools on this engine, as the core decides it from the installed
     * engine's descriptor (the family's tool parser). False when the core cannot tell, e.g. the
     * engine is not installed.
     */
    async isToolSupported(modelId: string): Promise<boolean> {
      try {
        const capabilities = (await this.core.capabilities(modelId)) as unknown as { tools?: boolean }
        return capabilities.tools === true
      } catch {
        return false
      }
    }

    // ── Session management ───────────────────────────────────────────────────

    async load(
      modelId: string,
      overrideSettings?: Record<string, unknown>,
      _isEmbedding: boolean = false,
      _bypassAutoUnload: boolean = false,
      options?: ModelLoadOptions
    ): Promise<SessionInfo> {
      // A first start takes minutes; the stages the core reports are what the person sees meanwhile.
      const unlisten = options?.onStage
        ? await deps.listen<CoreSessionLoadProgress>(LOAD_PROGRESS_EVENT, (event) => {
            const progress = event.payload
            if (progress?.provider !== this.provider || progress.model_id !== modelId) return
            options.onStage?.({ kind: 'startingEngine', stage: progress.stage, elapsedMs: progress.elapsed_ms })
          })
        : undefined
      try {
        return await this.loadModel(modelId, overrideSettings)
      } finally {
        unlisten?.()
      }
    }

    private loadModel(modelId: string, overrideSettings?: Record<string, unknown>): Promise<SessionInfo> {
      return this.loadCancel.track(modelId, async () => {
        try {
          // The core loads with its own copy of the settings; hand the user's over first.
          await this.coreSettings.ensureReady()
          this.loadCancel.throwIfCancelled(modelId)
          const session = await this.loadCancel.loadInCore(modelId, () =>
            this.core.load(modelId, overrideSettings ? { settings: overrideSettings } : {})
          )
          return this.toSessionInfo(session)
        } catch (error) {
          throw toLoadError(error)
        }
      })
    }

    cancelLoad(modelId: string): Promise<boolean> {
      return this.loadCancel.cancelLoad(modelId)
    }

    /**
     * Stopped means the core no longer serves the model, not that `unload` answered: the core
     * answers `success` for an id it has no session for, so an id that reached it wrong would look
     * stopped while the container kept the card (task 3.14, F-9). The call and its outcome go to the
     * app log.
     */
    async unload(modelId: string): Promise<UnloadResult> {
      logger.info(`${tag} unload ${modelId}`)
      let result: UnloadResult
      try {
        result = await this.core.unload(modelId)
        if (result.success && (await this.core.findSession(modelId))) {
          result = {
            success: false,
            error: `${label} model ${modelId} is still loaded after the unload.`,
          }
        }
      } catch (error) {
        result = { success: false, error: describeCoreError(error) }
      }
      if (result.success) logger.info(`${tag} unloaded ${modelId}`)
      else logger.warn(`${tag} unload ${modelId} failed: ${result.error ?? 'no reason given'}`)
      return result
    }

    async getLoadedModels(): Promise<string[]> {
      return this.core.getLoadedModels()
    }

    // ── Inference ────────────────────────────────────────────────────────────

    async chat(
      opts: chatCompletionRequest,
      abortController?: AbortController
    ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
      const session = await this.core.findSession(opts.model)
      if (!session) throw new Error(`${label} model ${opts.model} is not loaded.`)

      const url = `http://localhost:${session.port}/v1/chat/completions`
      const headers = {
        'Content-Type': 'application/json',
        'Authorization': `Bearer ${session.api_key}`,
      }
      const body = JSON.stringify(opts)
      if (opts.stream) return this.stream(url, headers, body, abortController)

      const response = await fetch(url, { method: 'POST', headers, body, signal: abortController?.signal })
      if (!response.ok) {
        const errData = await response.json().catch(() => null)
        throw new Error(`${label} request failed (${response.status}): ${JSON.stringify(errData)}`)
      }
      return (await response.json()) as chatCompletion
    }

    private async *stream(
      url: string,
      headers: Record<string, string>,
      body: string,
      abortController?: AbortController
    ): AsyncIterable<chatCompletionChunk> {
      const controller = new AbortController()
      const timeoutId = setTimeout(() => controller.abort(new Error('Request timed out')), this.timeout * 1000)
      if (abortController?.signal) {
        if (abortController.signal.aborted) controller.abort(abortController.signal.reason)
        else
          abortController.signal.addEventListener('abort', () => controller.abort(abortController.signal.reason), {
            once: true,
          })
      }
      const response = await fetch(url, { method: 'POST', headers, body, signal: controller.signal }).finally(() =>
        clearTimeout(timeoutId)
      )
      if (!response.ok) {
        const errData = await response.json().catch(() => null)
        throw new Error(`${label} streaming request failed (${response.status}): ${JSON.stringify(errData)}`)
      }
      if (!response.body) throw new Error('Response body is null')

      const reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      try {
        while (true) {
          const { done, value } = await reader.read()
          if (done) break
          buffer += decoder.decode(value, { stream: true })
          const lines = buffer.split('\n')
          buffer = lines.pop() ?? ''
          for (const line of lines) {
            const trimmed = line.trim()
            if (!trimmed || trimmed === 'data: [DONE]') continue
            if (trimmed.startsWith('data: ')) yield JSON.parse(trimmed.slice(6)) as chatCompletionChunk
          }
        }
      } finally {
        reader.releaseLock()
      }
    }

    // ── Operations the app does elsewhere ────────────────────────────────────

    async delete(modelId: string): Promise<void> {
      await this.deleteWithReport(modelId)
    }

    /**
     * Delete a model of the shared store through the core (`DELETE /managed-models/:id`, spec
     * `managed-model-store`): only the core knows whether the model is loaded — in this engine or
     * any other managed one — and owns every engine cache of it, so it stops the container, waits
     * for Docker to confirm, then removes the caches and the folder. The model is gone for every
     * managed engine. The app never touches the folder itself. Answers the space freed;
     * `AIEngine.delete` has no room for it, so the app asks for this method by name where it can
     * show the number.
     */
    async deleteWithReport(modelId: string): Promise<{ freedBytes: number }> {
      logger.info(`${tag} delete ${modelId}`)
      try {
        const deletion = await this.coreCall<ManagedModelDeletion>('DELETE', `/managed-models/${modelId}`)
        logger.info(
          `${tag} deleted ${modelId}: ${deletion.freed_bytes} bytes freed, ` +
            `${deletion.engine_caches_removed} engine caches, ${deletion.was_loaded ? 'was' : 'was not'} loaded`
        )
        return { freedBytes: deletion.freed_bytes }
      } catch (error) {
        logger.warn(`${tag} delete ${modelId} failed: ${describeCoreError(error)}`)
        throw deletionError(modelId, error)
      }
    }

    async update(_modelId: string, _model: Partial<modelInfo>): Promise<void> {
      throw new Error(`${label} models are described by their model.yml and cannot be edited.`)
    }

    async import(_modelId: string, _opts: ImportOptions): Promise<void> {
      throw new Error(`${label} models are downloaded in the Model Hub, not imported.`)
    }

    async abortImport(_modelId: string): Promise<void> {}

    // ── Helpers ──────────────────────────────────────────────────────────────

    /** The core's session in the `@janhq/core` shape; `pid` is null, a container has none. */
    private toSessionInfo(session: CoreSessionInfo): SessionInfo {
      return {
        pid: session.pid,
        port: session.port,
        model_id: session.model_id,
        model_path: session.model_path,
        is_embedding: false,
        api_key: session.api_key,
      } as SessionInfo
    }

    private coreCall<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
      return deps.invoke<T>('atomic_core_call', { method, path, body: body ?? null })
    }
  }
}
