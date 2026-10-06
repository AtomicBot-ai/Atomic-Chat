/**
 * TensorRT-LLM Extension (Linux and Windows)
 *
 * NVIDIA's TensorRT-LLM as one more local engine. `atomic-chat-core` runs `trtllm-serve` in a
 * Docker container on one NVIDIA GPU and serves each loaded model on a loopback gateway that
 * checks the session's Bearer key (openspec change `add-tensorrt-llm-linux`):
 *
 *   extension → atomic-chat-core → session gateway → container (trtllm-serve)
 *
 * The core owns the environment (Docker, the NVIDIA Container Toolkit, the engine image), every
 * load and unload, and each model's capabilities. This extension keeps what an engine extension
 * always keeps: the model list (`<root>/<id>/model.yml`, written last by the app's downloader, under
 * the root the core names — `<data>/tensorrt-llm/models` on Linux, Atomic Chat's WSL distribution on
 * Windows), the settings, and whether the provider is shown at all.
 *
 * Built into the Linux and Windows apps (`build:extensions:linux`, `build:extensions:win32`). On
 * Windows the core runs the container inside Atomic Chat's own WSL distribution (change
 * `add-tensorrt-llm-windows`) and hides the provider on ARM and until conf publishes the Windows
 * environment manifest.
 */

import {
  AIEngine,
  chatCompletion,
  chatCompletionChunk,
  chatCompletionRequest,
  fs,
  getJanDataFolderPath,
  ImportOptions,
  joinPath,
  ModelLoadOptions,
  modelInfo,
  SessionInfo,
  UnloadResult,
} from '@janhq/core'

import { info, warn, error as logError } from '@tauri-apps/plugin-log'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import { createCoreRuntime, describeCoreError, isCoreError } from '../../shared/atomicCoreRuntime'
import type {
  CoreSessionInfo,
  CoreSessionLoadProgress,
  Invoke,
} from '../../shared/atomicCoreRuntime'
import { createCoreSettingsSync } from '../../shared/atomicCoreSettingsSync'
import type { PersistedSetting } from '../../shared/atomicCoreSettingsSync'
import { LoadCancelTracker, toLoadError } from '../../shared/loadCancel'
import {
  descriptorHint,
  ENGINE_ID,
  isProviderHidden,
  type EnvironmentView,
  type PlanVerdict,
} from './visibility'

const CORE_SETTINGS_CHANGED_EVENT = 'atomic-core://settings:changed'
/** The core's stages of a container-backed load (`CoreSessionLoadProgress`). */
const LOAD_PROGRESS_EVENT = 'atomic-core://session:load-progress'

/** `model.yml` as the app's downloader writes it (the core's `tensorrt-llm` schema). */
interface TensorrtLlmModelYml {
  repository?: string | null
  revision?: string | null
  architectures?: string[]
  quantization?: string | null
  files?: Array<{ path: string; size: number; sha256?: string | null }>
}

/** What `DELETE /models/tensorrt-llm/:id` answers (core task 2.24). */
interface TensorrtLlmModelDeletion {
  model_id: string
  was_loaded: boolean
  freed_bytes: number
  engine_caches_removed: number
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
      ? `TensorRT-LLM could not stop ${modelId}, so its files were not touched. Try again, or check Docker.`
      : code === 'MODEL_NOT_FOUND'
        ? `TensorRT-LLM has no model ${modelId}. It may have been deleted already.`
        : `TensorRT-LLM could not delete ${modelId}: ${describeCoreError(error)}`
  return Object.assign(new Error(message), { code })
}

const logger = {
  info: (...args: unknown[]) => {
    console.log(...args)
    info(args.map(String).join(' '))
  },
  warn: (...args: unknown[]) => {
    console.warn(...args)
    warn(args.map(String).join(' '))
  },
  error: (...args: unknown[]) => {
    console.error(...args)
    logError(args.map(String).join(' '))
  },
}

export default class TensorrtLlmExtension extends AIEngine {
  readonly provider: string = 'tensorrt-llm'
  readonly providerId: string = 'tensorrt-llm'

  /** Seconds before a streaming chat request is considered timed out. */
  timeout: number = 600

  private readonly core = createCoreRuntime(ENGINE_ID, ((command, args) =>
    args === undefined ? invoke(command) : invoke(command, args)) as Invoke)
  private readonly loadCancel = new LoadCancelTracker(this.core, (message) => logger.warn(message))
  private readonly coreSettings = createCoreSettingsSync({
    core: this.core,
    readSettings: async () => (await this.getSettings()) as unknown as PersistedSetting[],
    writeSettings: (settings) => this.updateSettings(settings as never),
    setMirroring: () => {},
  })
  private unlistenCoreSettingsChanged?: () => void
  private providerPath?: string
  /** The models folder the core named last; `null` once it said there is none. */
  private modelsRoot?: string | null
  /** Hidden until the core says otherwise: a provider that cannot run here must not flash up. */
  private hidden = true
  /** Whether `hidden` is the core's answer, or only the default nobody has confirmed yet. */
  private known = false
  /** The probe in flight, shared by every caller that asks while it runs. */
  private visibilityCheck?: Promise<boolean>

  override async onLoad(): Promise<void> {
    super.onLoad()
    this.registerSettings(structuredClone(SETTINGS))
    this.unlistenCoreSettingsChanged = await listen(
      CORE_SETTINGS_CHANGED_EVENT,
      (event: { payload?: { provider?: string } }) => {
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

  override async onUnload(): Promise<void> {
    this.unlistenCoreSettingsChanged?.()
    this.unlistenCoreSettingsChanged = undefined
    // Containers belong to the core; there is nothing to stop here.
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

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
   * without an app update. A core that cannot answer hides it, as it would any engine it cannot run.
   * A call made while a probe runs waits for that probe rather than starting another.
   */
  refreshVisibility(): Promise<boolean> {
    this.visibilityCheck ??= this.probeVisibility().finally(() => {
      this.visibilityCheck = undefined
    })
    return this.visibilityCheck
  }

  private async probeVisibility(): Promise<boolean> {
    try {
      const { environments } = await this.coreCall<{ environments: EnvironmentView[] }>('GET', '/environments')
      const plan = await this.coreCall<PlanVerdict>('POST', '/environments/probe', {
        descriptor_id: descriptorHint(environments ?? []),
        target: { kind: 'runtime', installation_id: ENGINE_ID, engine_id: ENGINE_ID },
      })
      this.hidden = isProviderHidden(plan)
      this.known = true
    } catch (e) {
      // A core restarting or unreachable says nothing about the machine: keep the last answer.
      logger.warn(`TensorRT-LLM availability could not be checked: ${describeCoreError(e)}`)
    }
    return !this.hidden
  }

  // ── Model catalogue ────────────────────────────────────────────────────────

  async getProviderPath(): Promise<string> {
    if (!this.providerPath) {
      this.providerPath = await joinPath([await getJanDataFolderPath(), ENGINE_ID])
    }
    return this.providerPath
  }

  /**
   * The folder the core keeps this provider's models in (`GET /models/tensorrt-llm/location`, change
   * `add-tensorrt-llm-windows`), spelled as the app's own path calls spell it. `null` where the core
   * names none: on Windows before Atomic Chat's distribution is imported. A core that cannot answer
   * right now (restarting, not attached yet) leaves the folder it named last: that says nothing
   * about where the models are, and must not make them vanish.
   */
  private async modelsDir(): Promise<string | null> {
    try {
      const { root } = await this.coreCall<{ root: string; free_bytes: number | null }>(
        'GET',
        `/models/${ENGINE_ID}/location`
      )
      this.modelsRoot = await joinPath([root])
      return this.modelsRoot
    } catch (e) {
      const code = isCoreError(e) ? e.code : undefined
      if (code === 'MANAGED_ADAPTER_UNAVAILABLE' || code === 'PROVIDER_NOT_FOUND') {
        this.modelsRoot = null
      } else {
        logger.warn(`TensorRT-LLM models root not reported now, using the last one: ${describeCoreError(e)}`)
      }
      return this.modelsRoot ?? null
    }
  }

  /**
   * Every folder under the models root holding a `model.yml`, found the way the core finds them: a
   * folder with one is a model and is not descended into, a folder without one (a download in
   * progress) is not a model. The id is the folder's path under the root.
   */
  override async list(): Promise<modelInfo[]> {
    const modelsDir = await this.modelsDir()
    if (modelsDir === null || !(await fs.existsSync(modelsDir))) return []

    const ids: string[] = []
    const stack = [modelsDir]
    while (stack.length > 0) {
      const dir = stack.pop() as string
      if (dir !== modelsDir && (await fs.existsSync(await joinPath([dir, 'model.yml'])))) {
        ids.push(dir.slice(modelsDir.length + 1).replace(/\\/g, '/'))
        continue
      }
      for (const child of await fs.readdirSync(dir)) {
        if ((await fs.fileStat(child))?.isDirectory) stack.push(child)
      }
    }

    const models: modelInfo[] = []
    for (const id of ids) {
      try {
        models.push(await this.describe(id, modelsDir))
      } catch (e) {
        logger.warn(`Skipping TensorRT-LLM model ${id}: ${describeCoreError(e)}`)
      }
    }
    return models
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
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
    const yml = await invoke<TensorrtLlmModelYml>('read_yaml', {
      path: await joinPath([modelsDir, id, 'model.yml']),
    })
    const capabilities = (await this.isToolSupported(id)) ? ['tools'] : []
    return {
      id,
      name: yml.repository ?? id,
      providerId: this.provider,
      port: 0,
      sizeBytes: (yml.files ?? []).reduce((total, file) => total + (file.size ?? 0), 0),
      path: await joinPath([modelsDir, id]),
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    }
  }

  /**
   * Whether the model calls tools, as the core decides it from the installed engine's descriptor
   * (the family's tool parser). False when the core cannot tell, e.g. the engine is not installed.
   */
  override async isToolSupported(modelId: string): Promise<boolean> {
    try {
      const capabilities = (await this.core.capabilities(modelId)) as unknown as { tools?: boolean }
      return capabilities.tools === true
    } catch {
      return false
    }
  }

  // ── Session management ─────────────────────────────────────────────────────

  override async load(
    modelId: string,
    overrideSettings?: Record<string, unknown>,
    _isEmbedding: boolean = false,
    _bypassAutoUnload: boolean = false,
    options?: ModelLoadOptions
  ): Promise<SessionInfo> {
    // A first start takes minutes; the stages the core reports are what the person sees meanwhile.
    const unlisten = options?.onStage
      ? await listen<CoreSessionLoadProgress>(LOAD_PROGRESS_EVENT, (event) => {
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

  override cancelLoad(modelId: string): Promise<boolean> {
    return this.loadCancel.cancelLoad(modelId)
  }

  /**
   * Stopped means the core no longer serves the model, not that `unload` answered: the core answers
   * `success` for an id it has no session for, so an id that reached it wrong would look stopped
   * while the container kept the card (task 3.14, F-9). The call and its outcome go to the app log.
   */
  override async unload(modelId: string): Promise<UnloadResult> {
    logger.info(`[tensorrt-llm] unload ${modelId}`)
    let result: UnloadResult
    try {
      result = await this.core.unload(modelId)
      if (result.success && (await this.core.findSession(modelId))) {
        result = {
          success: false,
          error: `TensorRT-LLM model ${modelId} is still loaded after the unload.`,
        }
      }
    } catch (error) {
      result = { success: false, error: describeCoreError(error) }
    }
    if (result.success) logger.info(`[tensorrt-llm] unloaded ${modelId}`)
    else logger.warn(`[tensorrt-llm] unload ${modelId} failed: ${result.error ?? 'no reason given'}`)
    return result
  }

  override async getLoadedModels(): Promise<string[]> {
    return this.core.getLoadedModels()
  }

  // ── Inference ──────────────────────────────────────────────────────────────

  override async chat(
    opts: chatCompletionRequest,
    abortController?: AbortController
  ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
    const session = await this.core.findSession(opts.model)
    if (!session) throw new Error(`TensorRT-LLM model ${opts.model} is not loaded.`)

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
      throw new Error(`TensorRT-LLM request failed (${response.status}): ${JSON.stringify(errData)}`)
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
      throw new Error(`TensorRT-LLM streaming request failed (${response.status}): ${JSON.stringify(errData)}`)
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

  // ── Operations the app does elsewhere ──────────────────────────────────────

  override async delete(modelId: string): Promise<void> {
    await this.deleteWithReport(modelId)
  }

  /**
   * Delete a model through the core (`DELETE /models/tensorrt-llm/:id`, design D12a): only the core
   * knows whether the model is loaded and owns its engine caches, so it stops the container, waits
   * for Docker to confirm, then removes every engine cache of the model and its folder. The app
   * never touches the folder itself. Answers the space freed; `AIEngine.delete` has no room for
   * it, so the app asks for this method by name where it can show the number.
   */
  async deleteWithReport(modelId: string): Promise<{ freedBytes: number }> {
    logger.info(`[tensorrt-llm] delete ${modelId}`)
    try {
      const deletion = await this.coreCall<TensorrtLlmModelDeletion>('DELETE', `/models/${ENGINE_ID}/${modelId}`)
      logger.info(
        `[tensorrt-llm] deleted ${modelId}: ${deletion.freed_bytes} bytes freed, ` +
          `${deletion.engine_caches_removed} engine caches, ${deletion.was_loaded ? 'was' : 'was not'} loaded`
      )
      return { freedBytes: deletion.freed_bytes }
    } catch (error) {
      logger.warn(`[tensorrt-llm] delete ${modelId} failed: ${describeCoreError(error)}`)
      throw deletionError(modelId, error)
    }
  }

  override async update(_modelId: string, _model: Partial<modelInfo>): Promise<void> {
    throw new Error('TensorRT-LLM models are described by their model.yml and cannot be edited.')
  }

  override async import(_modelId: string, _opts: ImportOptions): Promise<void> {
    throw new Error('TensorRT-LLM models are downloaded from the provider page, not imported.')
  }

  override async abortImport(_modelId: string): Promise<void> {}

  // ── Helpers ────────────────────────────────────────────────────────────────

  /** The core's session in the `@janhq/core` shape; `pid` is null, a container has none. */
  private toSessionInfo(session: CoreSessionInfo): SessionInfo {
    return {
      pid: session.pid,
      port: session.port,
      model_id: session.model_id,
      model_path: session.model_path,
      is_embedding: false,
      api_key: session.api_key,
    }
  }

  private coreCall<T>(method: 'GET' | 'POST' | 'DELETE', path: string, body?: unknown): Promise<T> {
    return invoke<T>('atomic_core_call', { method, path, body: body ?? null })
  }
}
