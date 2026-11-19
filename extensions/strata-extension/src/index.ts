import {
  AIEngine,
  getJanDataFolderPath,
  joinPath,
  type chatCompletion,
  type chatCompletionChunk,
  type chatCompletionRequest,
  type modelInfo,
  type SessionInfo,
  type UnloadResult,
} from '@janhq/core'
import { invoke } from '@tauri-apps/api/core'
import { listen } from '@tauri-apps/api/event'
import {
  createCoreRuntime,
  describeCoreError,
  isCoreError,
} from '../../shared/atomicCoreRuntime'
import {
  createCoreSettingsSync,
  type PersistedSetting,
} from '../../shared/atomicCoreSettingsSync'
import { LoadCancelTracker, toLoadError } from '../../shared/loadCancel'
import settings from '../settings.json'

const provider = 'strata'
const updateRequired = 'Update Atomic Chat to use Strata.'
const modelIdPattern = /^[a-z0-9][a-z0-9._-]*$/

interface ModelCheck {
  verdict: string
  preparation_status: string | null
  capabilities: StrataCapabilities | null
}

interface StrataCapabilities {
  tools: boolean
  reasoning: boolean
  vision: boolean
}

interface ReadyJob {
  model_id: string
  state: string
  removing?: boolean
  plan: {
    descriptor: { name: string; requirements: { download_bytes: number } }
    source_digest: string
  }
  prepared_build?: { tag: string; backend_id: string }
  capabilities?: StrataCapabilities
}

const call = <T>(method: 'POST' | 'GET', path: string, body: unknown = null) =>
  invoke<T>('atomic_core_call', { method, path, body })

async function* streamChat(
  response: Response
): AsyncIterable<chatCompletionChunk> {
  if (!response.body) throw new Error('The Strata response has no stream.')
  const reader = response.body.getReader()
  const decoder = new TextDecoder()
  let buffer = ''
  try {
    while (true) {
      const { done, value } = await reader.read()
      if (done) return
      const lines = (buffer + decoder.decode(value, { stream: true })).split(
        '\n'
      )
      buffer = lines.pop() ?? ''
      for (const line of lines) {
        if (!line.startsWith('data:')) continue
        const data = line.slice(5).trim()
        if (data === '[DONE]') return
        if (data) yield JSON.parse(data) as chatCompletionChunk
      }
    }
  } finally {
    await reader.cancel().catch(() => {})
    reader.releaseLock()
  }
}

export default class StrataExtension extends AIEngine {
  readonly provider = provider
  readonly providerId = provider
  private readonly core = createCoreRuntime(provider, invoke)
  private readonly loadCancel = new LoadCancelTracker(this.core, console.warn)
  private readonly coreSettings = createCoreSettingsSync({
    core: this.core,
    readSettings: async () =>
      (await this.getSettings()) as unknown as PersistedSetting[],
    writeSettings: (values) => this.updateSettings(values as never),
    setMirroring: () => {},
  })
  private unlisten?: () => void
  private visible = false
  private known = false
  private reason: string | null = null
  private build: ReadyJob['prepared_build']
  private validated = new Map<string, Promise<ModelCheck>>()
  private probe?: Promise<boolean>

  override async onLoad() {
    super.onLoad()
    await this.registerSettings(structuredClone(settings) as never)
    this.unlisten = await listen<{ provider: string }>(
      'atomic-core://settings:changed',
      ({ payload }) => {
        if (payload.provider === provider) {
          this.validated.clear()
          void this.coreSettings
            .mirror()
            .catch((error) => console.warn(describeCoreError(error)))
        }
      }
    )
    void this.refreshVisibility()
  }

  async onUnload() {
    this.unlisten?.()
    this.unlisten = undefined
  }

  isHidden() {
    return !this.visible
  }
  visibilityKnown() {
    return this.known
  }
  visibilityReason() {
    return this.reason
  }

  refreshVisibility(): Promise<boolean> {
    this.probe ??= this.checkAvailability().finally(() => {
      this.probe = undefined
    })
    return this.probe
  }

  private async checkAvailability(): Promise<boolean> {
    try {
      const catalog = await this.core.engineBuildCatalog(provider)
      if (
        this.build?.tag !== catalog.active?.tag ||
        this.build?.backend_id !== catalog.active?.backend_id
      )
        this.validated.clear()
      this.build = catalog.active ?? undefined
      this.visible = !!(catalog.active || catalog.host_backend_id)
      this.reason = this.visible
        ? null
        : (catalog.host_reason ?? catalog.manifest_error)
      this.known = true
    } catch (error) {
      if (
        isCoreError(error) &&
        ['INVALID_ARGUMENT', 'PROVIDER_NOT_FOUND', 'NOT_FOUND'].includes(
          error.code
        )
      ) {
        this.visible = false
        this.reason = updateRequired
        this.known = true
      } else {
        console.warn(describeCoreError(error))
      }
    }
    return this.visible
  }

  private async describe(job: ReadyJob): Promise<modelInfo | undefined> {
    const id = job.model_id
    if (
      !this.build ||
      !modelIdPattern.test(id) ||
      id.endsWith('.') ||
      job.state !== 'ready' ||
      job.removing
    )
      return undefined
    const path = await joinPath([
      await getJanDataFolderPath(),
      provider,
      'models',
      id,
    ])
    const yml = await invoke<{ strata: { source_digest: string } }>(
      'read_yaml',
      {
        path: await joinPath([path, 'model.yml']),
      }
    )
    if (yml.strata?.source_digest !== job.plan.source_digest) return undefined

    let caps = job.capabilities
    if (
      this.build.tag !== job.prepared_build?.tag ||
      this.build.backend_id !== job.prepared_build?.backend_id
    ) {
      // A differing build may invalidate the prepared cache. Verify once per
      // model and build, since the full check hashes all source files.
      const key = `${id}:${job.plan.source_digest}`
      let pending = this.validated.get(key)
      if (!pending) {
        pending = call<ModelCheck>('POST', '/models/strata/check', {
          model_id: id,
        })
        this.validated.set(key, pending)
        void pending.then(
          (result) => {
            if (result.verdict !== 'ok') this.validated.delete(key)
          },
          () => this.validated.delete(key)
        )
      }
      const check = await pending
      if (check.verdict !== 'ok' || check.preparation_status !== 'ready')
        return undefined
      caps = check.capabilities ?? undefined
    }
    const capabilities = [
      ...(caps?.tools ? ['tools'] : []),
      ...(caps?.reasoning ? ['reasoning'] : []),
      ...(caps?.vision &&
      (await this.getSettings()).find((setting) => setting.key === 'vision')
        ?.controllerProps.value !== 'off'
        ? ['vision']
        : []),
    ]
    const descriptor = job.plan.descriptor
    return {
      id,
      name: descriptor.name,
      providerId: provider,
      port: 0,
      path,
      sizeBytes: descriptor.requirements.download_bytes,
      capabilities,
      strata: descriptor,
    }
  }

  async getMaxCtxTrain(id: string): Promise<number | undefined> {
    const result = await call<{ max_context_length: number }>(
      'GET', '/models/strata/' + encodeURIComponent(id) + '/context-limit'
    )
    return result.max_context_length
  }

  override async get(id: string): Promise<modelInfo | undefined> {
    const job = (await invoke<ReadyJob[]>('atomic_strata_jobs')).find(
      (job) => job.model_id === id
    )
    if (!job) return undefined
    return this.describe(job).catch(() => undefined)
  }

  override async list(): Promise<modelInfo[]> {
    const jobs = await invoke<ReadyJob[]>('atomic_strata_jobs')
    const rows = await Promise.all(
      jobs.map((job) =>
        this.describe(job).catch((error) => {
          console.warn(describeCoreError(error))
          return undefined
        })
      )
    )
    return rows.filter((row): row is modelInfo => row !== undefined)
  }

  override async isToolSupported(id: string) {
    return (await this.get(id))?.capabilities.includes('tools') ?? false
  }

  override async getReasoningControls(id: string) {
    return {
      supportsThinking:
        (await this.get(id))?.capabilities.includes('reasoning') ?? false,
    }
  }

  syncSettings() {
    return this.coreSettings.ensureReady()
  }

  override async load(
    id: string,
    settings?: Record<string, unknown>,
    _embedding?: boolean,
    bypassAutoUnload?: boolean
  ): Promise<SessionInfo> {
    return this.loadCancel.track(id, async () => {
      try {
        await this.syncSettings()
        this.loadCancel.throwIfCancelled(id)
        const { mmproj_path, ...session } = await this.loadCancel.loadInCore(
          id,
          () => this.core.load(id, { settings, bypassAutoUnload })
        )
        return { ...session, ...(mmproj_path ? { mmproj_path } : {}) }
      } catch (error) {
        throw toLoadError(error)
      }
    })
  }

  override cancelLoad(id: string) {
    return this.loadCancel.cancelLoad(id)
  }
  override getLoadedModels() {
    return this.core.getLoadedModels()
  }

  override async unload(id: string): Promise<UnloadResult> {
    try {
      return await this.core.unload(id)
    } catch (error) {
      return { success: false, error: describeCoreError(error) }
    }
  }

  override async chat(request: chatCompletionRequest, abort?: AbortController) {
    const session = await this.core.findSession(request.model)
    if (!session) throw new Error('The Strata model is no longer loaded.')
    const response = await fetch(
      `http://localhost:${session.port}/v1/chat/completions`,
      {
        method: 'POST',
        headers: {
          'Authorization': `Bearer ${session.api_key}`,
          'Content-Type': 'application/json',
        },
        body: JSON.stringify(request),
        signal: abort?.signal,
      }
    )
    if (!response.ok) {
      const body = await response.json().catch(() => null)
      throw new Error(
        body?.error?.message ?? `Strata request failed (${response.status}).`
      )
    }
    return request.stream
      ? streamChat(response)
      : ((await response.json()) as chatCompletion)
  }

  override async delete(modelId: string) {
    await invoke('atomic_strata_remove_model', { modelId })
  }

  override async update() {
    throw new Error('Strata model metadata comes from its pinned descriptor.')
  }
  override async import() {
    throw new Error('Use the Strata model card to import a pinned source set.')
  }
  override async abortImport() {}
}
