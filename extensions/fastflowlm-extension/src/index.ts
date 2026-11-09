/** FastFlowLM provider: core owns readiness, sessions and cancellation; the app owns model installation. */
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

import {
  createCoreRuntime,
  describeCoreError,
} from '../../shared/atomicCoreRuntime'
import type { CoreSessionInfo, Invoke } from '../../shared/atomicCoreRuntime'
import { createCoreSettingsSync } from '../../shared/atomicCoreSettingsSync'
import type { PersistedSetting } from '../../shared/atomicCoreSettingsSync'
import { LoadCancelTracker, toLoadError } from '../../shared/loadCancel'

const PROVIDER = 'fastflowlm'
const LABEL = 'FastFlowLM'
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

interface FastFlowLmBlock {
  variant_id: string
  capabilities: {
    chat: boolean
    tools: boolean
    reasoning: boolean
    structured_output: boolean
  }
}
interface FastFlowLmModelYml {
  name?: string
  size_bytes?: number
  fastflowlm?: FastFlowLmBlock
}
function isBlock(value: unknown): value is FastFlowLmBlock {
  const block = value as FastFlowLmBlock | undefined
  return (
    !!block &&
    typeof block.variant_id === 'string' &&
    block.capabilities?.chat === true
  )
}

export default class FastFlowLmExtension extends AIEngine {
  readonly provider: string = PROVIDER
  readonly providerId: string = PROVIDER

  timeout: number = 600

  private readonly core = createCoreRuntime(PROVIDER, ((command, args) =>
    args === undefined ? invoke(command) : invoke(command, args)) as Invoke)
  private readonly loadCancel = new LoadCancelTracker(this.core, (message) =>
    logger.warn(message)
  )
  private readonly coreSettings = createCoreSettingsSync({
    core: this.core,
    readSettings: async () =>
      (await this.getSettings()) as unknown as PersistedSetting[],
    writeSettings: (settings) => this.updateSettings(settings as never),
    setMirroring: () => {},
  })
  private unlistenCoreSettingsChanged?: () => void
  private providerPath?: string

  private hidden = true

  private known = false

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
            logger.warn(
              `[atomic-core] could not mirror changed settings: ${describeCoreError(e)}`
            )
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

  isHidden(): boolean {
    return this.hidden
  }

  visibilityKnown(): boolean {
    return this.known
  }

  refreshVisibility(): Promise<boolean> {
    this.visibilityCheck ??= this.probeVisibility().finally(() => {
      this.visibilityCheck = undefined
    })
    return this.visibilityCheck
  }

  private async probeVisibility(): Promise<boolean> {
    try {
      const { engines } = await this.coreCall<{
        engines?: Array<{ engine?: string }>
      }>('POST', '/engines/versions', {})
      this.hidden = !(engines ?? []).some((entry) => entry.engine === PROVIDER)
      this.known = true
    } catch (e) {
      logger.warn(
        `${LABEL} availability could not be checked: ${describeCoreError(e)}`
      )
    }
    return !this.hidden
  }

  // ── Model catalogue ────────────────────────────────────────────────────────

  async getProviderPath(): Promise<string> {
    if (!this.providerPath) {
      this.providerPath = await joinPath([
        await getJanDataFolderPath(),
        PROVIDER,
      ])
    }
    return this.providerPath
  }

  private async modelsDir(): Promise<string> {
    return joinPath([await this.getProviderPath(), 'models'])
  }

  private listing?: Promise<modelInfo[]>
  private listRevision = 0

  invalidateModelList(): void {
    this.listRevision++
  }

  override list(): Promise<modelInfo[]> {
    if (this.listing) return this.listing
    // A mutation invalidates the answer, never the in-flight scan guard.
    const pending = (async () => {
      for (;;) {
        const revision = this.listRevision
        try {
          const models = await this.scanModels()
          if (revision === this.listRevision) return models
        } catch (error) {
          if (revision === this.listRevision) throw error
        }
      }
    })()
    this.listing = pending
    void pending
      .finally(() => {
        if (this.listing === pending) this.listing = undefined
      })
      .catch(() => {})
    return pending
  }

  private async scanModels(): Promise<modelInfo[]> {
    const root = await this.modelsDir()
    if (!(await fs.existsSync(root))) return []
    const candidates = await Promise.all(
      (await fs.readdirSync(root)).map(async (path: string) => {
        const id = path.replace(/\\/g, '/').split('/').at(-1) ?? ''
        if (
          !/^[a-z0-9][a-z0-9._-]*$/.test(id) ||
          !(await fs.fileStat(path))?.isDirectory
        )
          return undefined
        return (await fs.existsSync(await joinPath([root, id, 'model.yml'])))
          ? id
          : undefined
      })
    )
    // Core shares concurrent probes. Checks remain structural and never hash installed weights.
    const models = await Promise.all(
      candidates
        .filter((id): id is string => !!id)
        .map(async (id) => {
          try {
            return await this.describe(id, root)
          } catch (error) {
            logger.warn(
              `Skipping FastFlowLM model ${id}: ${describeCoreError(error)}`
            )
            return undefined
          }
        })
    )
    return models.filter((model): model is modelInfo => !!model)
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
    try {
      return await this.describe(modelId, await this.modelsDir())
    } catch {
      return undefined
    }
  }

  private async readModelYml(
    id: string,
    modelsDir: string
  ): Promise<FastFlowLmModelYml> {
    return invoke<FastFlowLmModelYml>('read_yaml', {
      path: await joinPath([modelsDir, id, 'model.yml']),
    })
  }

  private async describe(id: string, modelsDir: string): Promise<modelInfo> {
    const yml = await this.readModelYml(id, modelsDir)
    const checked = await this.coreCall<{
      verdict: string
      reason: string | null
      metadata: FastFlowLmBlock | null
    }>('POST', '/models/fastflowlm/check', { model_id: id })
    const block = checked.metadata
    if (
      checked.verdict === 'invalid-installation' ||
      !isBlock(block) ||
      block.variant_id !== id
    )
      throw new Error(checked.reason ?? 'Invalid FastFlowLM model identity')
    const capabilities = [
      ...(block.capabilities.tools === true ? ['tools'] : []),
      ...(block.capabilities.reasoning === true ? ['reasoning'] : []),
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

  override async isToolSupported(modelId: string): Promise<boolean> {
    try {
      const yml = await this.readModelYml(modelId, await this.modelsDir())
      return (
        isBlock(yml.fastflowlm) && yml.fastflowlm.capabilities.tools === true
      )
    } catch {
      return false
    }
  }

  // ── Session management ─────────────────────────────────────────────────────

  override async load(
    modelId: string,
    overrideSettings?: Record<string, unknown>
  ): Promise<SessionInfo> {
    return this.loadCancel.track(modelId, async () => {
      try {
        // The core loads with its own copy of the settings; hand the person's over first.
        await this.coreSettings.ensureReady()
        this.loadCancel.throwIfCancelled(modelId)
        const session = await this.loadCancel.loadInCore(modelId, () =>
          this.core.load(
            modelId,
            overrideSettings ? { settings: overrideSettings } : {}
          )
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

  override async unload(modelId: string): Promise<UnloadResult> {
    try {
      const result = await this.core.unload(modelId)
      if (result.success && (await this.core.findSession(modelId))) {
        return {
          success: false,
          error: `${LABEL} model ${modelId} is still loaded after the unload.`,
        }
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

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortController?.signal,
    })
    if (!response.ok) {
      const errData = await response.json().catch(() => null)
      throw new Error(
        `${LABEL} request failed (${response.status}): ${JSON.stringify(errData)}`
      )
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
    let timeoutId: ReturnType<typeof setTimeout> | undefined
    let reader: ReadableStreamDefaultReader<Uint8Array> | undefined
    const armTimeout = () => {
      clearTimeout(timeoutId)
      timeoutId = setTimeout(
        () => controller.abort(new Error('Request timed out')),
        this.timeout * 1000
      )
    }
    const abort = () => controller.abort(abortController?.signal.reason)
    if (abortController?.signal.aborted) abort()
    else
      abortController?.signal.addEventListener('abort', abort, { once: true })
    armTimeout()
    try {
      const response = await fetch(url, {
        method: 'POST',
        headers,
        body,
        signal: controller.signal,
      })
      if (!response.ok)
        throw new Error(
          `${LABEL} streaming request failed (${response.status}): ${JSON.stringify(await response.json().catch(() => null))}`
        )
      if (!response.body) throw new Error('Response body is null')
      reader = response.body.getReader()
      const decoder = new TextDecoder('utf-8')
      let buffer = ''
      while (true) {
        const { done, value } = await reader.read()
        if (done) break
        armTimeout()
        buffer += decoder.decode(value, { stream: true })
        const lines = buffer.split('\n')
        buffer = lines.pop() ?? ''
        for (const line of lines) {
          const trimmed = line.trim()
          if (trimmed === 'data: [DONE]') return
          if (trimmed.startsWith('data: '))
            yield JSON.parse(trimmed.slice(6)) as chatCompletionChunk
        }
      }
    } finally {
      clearTimeout(timeoutId)
      abortController?.signal.removeEventListener('abort', abort)
      controller.abort()
      await reader?.cancel().catch(() => {})
      reader?.releaseLock()
    }
  }

  // ── Operations the app does elsewhere ──────────────────────────────────────

  override async delete(modelId: string): Promise<void> {
    await this.deleteWithReport(modelId)
  }

  async deleteWithReport(modelId: string): Promise<{ freedBytes: number }> {
    const result = await invoke<{ freedBytes: number }>(
      'atomic_fastflowlm_remove_model',
      { modelId }
    )
    this.invalidateModelList()
    return result
  }

  override async update(
    _modelId: string,
    _model: Partial<modelInfo>
  ): Promise<void> {
    throw new Error(
      `${LABEL} models are described by their model.yml and cannot be edited.`
    )
  }

  override async import(_modelId: string, _opts: ImportOptions): Promise<void> {
    throw new Error(
      `${LABEL} models are downloaded in the Model Hub, not imported.`
    )
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

  private coreCall<T>(
    method: 'GET' | 'POST',
    path: string,
    body?: unknown
  ): Promise<T> {
    return invoke<T>('atomic_core_call', { method, path, body: body ?? null })
  }
}
