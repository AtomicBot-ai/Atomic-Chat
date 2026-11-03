/**
 * LiteRT-LM Extension (Windows x64, macOS on Apple Silicon, Linux x64/arm64)
 *
 * Google LiteRT-LM (`.litertlm` models) as a local provider (openspec change
 * `add-litert-lm-runtime`): `atomic-chat-core` runs each loaded model in its own host process — a
 * hidden mode of the core binary that loads the LiteRT-LM library on the variant's backend (CPU, GPU,
 * an Intel NPU through OpenVINO) and serves its own OpenAI-compatible server — behind a loopback
 * gateway that checks the session's Bearer key:
 *
 *   extension → atomic-chat-core → session gateway → litert-host → liblitert-lm
 *
 * What stays here:
 * - whether the provider is shown at all: exactly where the core registered `litert-lm`, which its
 *   versions answer says (`POST /engines/versions` lists an engine only on hosts it runs on). The app
 *   checks no platform itself (spec litert-lm-desktop);
 * - the model list: every folder under `<data>/litert-lm/models` with a `model.yml`, which the app's
 *   installer writes last; capabilities from its `litert_lm` block;
 * - loads and unloads through the core, chat by the session's port and key, the settings handed to
 *   the core before each load.
 *
 * Built into every desktop app; the core decides where it runs (macOS 12+ on Apple Silicon, Linux
 * x64/arm64 with glibc 2.27+, Windows x64).
 */

import {
  AIEngine,
  fs,
  getJanDataFolderPath,
  joinPath,
  type chatCompletion,
  type chatCompletionChunk,
  type chatCompletionRequest,
  type ImportOptions,
  type modelInfo,
  type SessionInfo,
  type UnloadResult,
} from '@janhq/core'
import { info, warn, error as logError } from '@tauri-apps/plugin-log'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'

import { createCoreRuntime, describeCoreError } from '../../shared/atomicCoreRuntime'
import type { CoreSessionInfo, Invoke } from '../../shared/atomicCoreRuntime'
import { createCoreSettingsSync } from '../../shared/atomicCoreSettingsSync'
import type { PersistedSetting } from '../../shared/atomicCoreSettingsSync'
import { LoadCancelTracker, toLoadError } from '../../shared/loadCancel'

const PROVIDER = 'litert-lm'
const LABEL = 'LiteRT-LM'
const CORE_SETTINGS_CHANGED_EVENT = 'atomic-core://settings:changed'

const logger = {
  info: (message: string) => {
    console.log(message)
    info(message)
  },
  warn: (message: string) => {
    console.warn(message)
    warn(message)
  },
  error: (message: string) => {
    console.error(message)
    logError(message)
  },
}

/** The `litert_lm` block the installer writes into `model.yml` (core `ModelYmlLiteRtLm`). */
interface LiteRtLmBlock {
  model_id: string
  variant_id: string
  backend: string
  npu?: string
  repo: string
  revision: string
  file: string
  context_length?: number
  tools?: boolean
  reasoning?: boolean
  vision?: boolean
  source?: string
}

interface LiteRtLmModelYml {
  model_path?: string
  name?: string
  size_bytes?: number
  litert_lm?: LiteRtLmBlock
}

function isBlock(value: unknown): value is LiteRtLmBlock {
  const block = value as LiteRtLmBlock | undefined
  return (
    !!block &&
    typeof block === 'object' &&
    typeof block.variant_id === 'string' &&
    typeof block.backend === 'string'
  )
}

export default class LiteRtLmExtension extends AIEngine {
  readonly provider: string = PROVIDER
  readonly providerId: string = PROVIDER

  /** Seconds before a streaming chat request is considered timed out. */
  timeout: number = 600

  private readonly core = createCoreRuntime(PROVIDER, ((command, args) =>
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
  /** Hidden until the core says otherwise: a provider that cannot run here must not flash up. */
  private hidden = true
  /** Whether `hidden` is the core's answer, or only the default nobody has confirmed yet. */
  private known = false
  /** The question in flight, shared by every caller that asks while it runs. */
  private visibilityCheck?: Promise<boolean>

  override async onLoad(): Promise<void> {
    super.onLoad()
    this.registerSettings(structuredClone(SETTINGS))
    this.unlistenCoreSettingsChanged = await listen<{ provider?: string }>(
      CORE_SETTINGS_CHANGED_EVENT,
      (event) => {
        if (event.payload?.provider !== this.provider) return
        void this.coreSettings
          .mirror()
          .catch((e) =>
            logger.warn(`[atomic-core] could not mirror changed settings: ${describeCoreError(e)}`)
          )
      }
    )
    // Not awaited: every extension's onLoad holds the UI back. The app's DataProvider waits for
    // this same answer and then updates the provider list.
    void this.refreshVisibility()
  }

  async onUnload(): Promise<void> {
    this.unlistenCoreSettingsChanged?.()
    this.unlistenCoreSettingsChanged = undefined
    // Host processes belong to the core; there is nothing to stop here.
  }

  // ── Visibility ─────────────────────────────────────────────────────────────

  /** Whether the provider stays out of the app's lists, as of the last {@link refreshVisibility}. */
  isHidden(): boolean {
    return this.hidden
  }

  /** Whether the core has answered at least once. */
  visibilityKnown(): boolean {
    return this.known
  }

  /**
   * Ask the core again whether it registered `litert-lm` on this host; `true` when the provider
   * should be shown. The versions answer lists an engine exactly where the core runs it (spec
   * "Провайдер регистрируется только на поддерживаемых платформах"), and asking it starts no
   * process. A core that cannot answer right now keeps the last answer.
   */
  refreshVisibility(): Promise<boolean> {
    this.visibilityCheck ??= this.probeVisibility().finally(() => {
      this.visibilityCheck = undefined
    })
    return this.visibilityCheck
  }

  private async probeVisibility(): Promise<boolean> {
    try {
      const { engines } = await this.coreCall<{ engines?: Array<{ engine?: string }> }>(
        'POST',
        '/engines/versions',
        {}
      )
      this.hidden = !(engines ?? []).some((entry) => entry.engine === PROVIDER)
      this.known = true
    } catch (e) {
      logger.warn(`${LABEL} availability could not be checked: ${describeCoreError(e)}`)
    }
    return !this.hidden
  }

  // ── Model catalogue ────────────────────────────────────────────────────────

  async getProviderPath(): Promise<string> {
    if (!this.providerPath) {
      this.providerPath = await joinPath([await getJanDataFolderPath(), PROVIDER])
    }
    return this.providerPath
  }

  private async modelsDir(): Promise<string> {
    return joinPath([await this.getProviderPath(), 'models'])
  }

  /**
   * Every folder under the models root holding a `model.yml`, found the way the core finds them: a
   * folder with one is a model and is not descended into; a folder without one (a download in
   * progress) is not a model. The id is the folder's path under the root — the variant id.
   */
  override async list(): Promise<modelInfo[]> {
    const modelsDir = await this.modelsDir()
    if (!(await fs.existsSync(modelsDir))) return []

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
        logger.warn(`Skipping ${LABEL} model ${id}: ${describeCoreError(e)}`)
      }
    }
    return models
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
    try {
      return await this.describe(modelId, await this.modelsDir())
    } catch {
      return undefined
    }
  }

  private async readModelYml(id: string, modelsDir: string): Promise<LiteRtLmModelYml> {
    return invoke<LiteRtLmModelYml>('read_yaml', {
      path: await joinPath([modelsDir, id, 'model.yml']),
    })
  }

  private async describe(id: string, modelsDir: string): Promise<modelInfo> {
    const yml = await this.readModelYml(id, modelsDir)
    const block = yml.litert_lm
    if (!isBlock(block)) throw new Error('model.yml has no litert_lm block')
    // Image attachments only for a variant whose block says the file reads images (spec
    // "Скачанные модели LiteRT-LM ведут себя как локальные").
    const capabilities = [
      ...(block.tools === true ? ['tools'] : []),
      ...(block.reasoning === true ? ['reasoning'] : []),
      ...(block.vision === true ? ['vision'] : []),
    ]
    return {
      id,
      name: yml.name ?? id,
      providerId: this.provider,
      port: 0,
      sizeBytes: yml.size_bytes ?? 0,
      path: await joinPath([modelsDir, id]),
      capabilities: capabilities.length > 0 ? capabilities : undefined,
    } as modelInfo
  }

  /**
   * Whether the variant calls tools, as its `litert_lm` block says (conf's list, or the core's check
   * of the file for a Hugging Face model). The core refuses a tool request to a model that does not,
   * so the app turns Agent mode off for it.
   */
  override async isToolSupported(modelId: string): Promise<boolean> {
    try {
      const yml = await this.readModelYml(modelId, await this.modelsDir())
      return isBlock(yml.litert_lm) && yml.litert_lm.tools === true
    } catch {
      return false
    }
  }

  // ── Session management ─────────────────────────────────────────────────────

  override async load(modelId: string, overrideSettings?: Record<string, unknown>): Promise<SessionInfo> {
    return this.loadCancel.track(modelId, async () => {
      try {
        // The core loads with its own copy of the settings; hand the person's over first.
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
   * The core answers only once the host process has exited (spec "Модель работает в отдельном
   * хост-процессе"). Stopped means the
   * core no longer serves the model: it answers `success` for an id it has no session for, so the
   * session list has the last word, as for the managed engines.
   */
  override async unload(modelId: string): Promise<UnloadResult> {
    try {
      const result = await this.core.unload(modelId)
      if (result.success && (await this.core.findSession(modelId))) {
        return { success: false, error: `${LABEL} model ${modelId} is still loaded after the unload.` }
      }
      return result
    } catch (error) {
      return { success: false, error: describeCoreError(error) }
    }
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
    if (!session) throw new Error(`${LABEL} model ${opts.model} is not loaded.`)

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
      throw new Error(`${LABEL} request failed (${response.status}): ${JSON.stringify(errData)}`)
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
      throw new Error(`${LABEL} streaming request failed (${response.status}): ${JSON.stringify(errData)}`)
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
   * Delete a variant: unload it if the core serves it, then remove its folder whole (spec
   * "Скачанный вариант лежит в папке провайдера с model.yml"). Answers the space freed, from `model.yml`;
   * `AIEngine.delete` has no room for it, so the app asks for this method by name where it shows
   * the number.
   */
  async deleteWithReport(modelId: string): Promise<{ freedBytes: number }> {
    const modelsDir = await this.modelsDir()
    const dir = await joinPath([modelsDir, modelId])
    if (!(await fs.existsSync(await joinPath([dir, 'model.yml'])))) {
      throw new Error(`${LABEL} has no model ${modelId}. It may have been deleted already.`)
    }
    const yml = await this.readModelYml(modelId, modelsDir)
    if (await this.core.findSession(modelId)) {
      const unloaded = await this.unload(modelId)
      if (!unloaded.success) {
        throw new Error(
          `${LABEL} could not stop ${modelId}, so its files were not touched: ${unloaded.error ?? 'no reason given'}`
        )
      }
    }
    await fs.rm(dir)
    logger.info(`[${PROVIDER}] deleted ${modelId}`)
    return { freedBytes: yml.size_bytes ?? 0 }
  }

  override async update(_modelId: string, _model: Partial<modelInfo>): Promise<void> {
    throw new Error(`${LABEL} models are described by their model.yml and cannot be edited.`)
  }

  override async import(_modelId: string, _opts: ImportOptions): Promise<void> {
    throw new Error(`${LABEL} models are downloaded in the Model Hub, not imported.`)
  }

  override async abortImport(_modelId: string): Promise<void> {}

  // ── Helpers ────────────────────────────────────────────────────────────────

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

  private coreCall<T>(method: 'GET' | 'POST', path: string, body?: unknown): Promise<T> {
    return invoke<T>('atomic_core_call', { method, path, body: body ?? null })
  }
}
