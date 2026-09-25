/**
 * Apple Foundation Models Extension
 *
 * Provides access to Apple's on-device Foundation Models (macOS 26+ with Apple
 * Intelligence) as a Jan AI engine. The model runs fully locally — no internet
 * connection or external API key is required.
 *
 * Architecture:
 *   extension (TypeScript) → atomic-chat-core → foundation-models-server (Swift)
 *                                                  ↓
 *                                      Apple FoundationModels.framework
 *
 * The core spawns a lightweight OpenAI-compatible HTTP server (`foundation-models-server`)
 * that wraps the system Foundation Models API, and answers whether this Mac can run it.
 * Chat requests go straight to that local server, keeping the same pattern used by the MLX
 * and llama.cpp engines.
 */

import {
  AIEngine,
  EngineManager,
  modelInfo,
  SessionInfo,
  UnloadResult,
  chatCompletion,
  chatCompletionChunk,
  ImportOptions,
  chatCompletionRequest,
} from '@janhq/core'

import { info, warn, error as logError } from '@tauri-apps/plugin-log'
import { invoke } from '@tauri-apps/api/core'
import {
  createCoreRuntime,
  describeCoreError,
} from '../../shared/atomicCoreRuntime'
import type {
  CoreSessionInfo,
  CoreSessionSummary,
  Invoke,
} from '../../shared/atomicCoreRuntime'

// ─── Constants ───────────────────────────────────────────────────────────────

/** The stable model ID used throughout Jan for the Apple on-device model. */
const APPLE_MODEL_ID = 'apple/on-device'

/** Display name shown in the Jan UI. */
const APPLE_MODEL_NAME = 'Apple On-Device Model'

// ─── Logger ──────────────────────────────────────────────────────────────────

const logger = {
  info: (...args: any[]) => {
    console.log(...args)
    info(args.map(String).join(' '))
  },
  warn: (...args: any[]) => {
    console.warn(...args)
    warn(args.map(String).join(' '))
  },
  error: (...args: any[]) => {
    console.error(...args)
    logError(args.map(String).join(' '))
  },
}

// ─── Extension ───────────────────────────────────────────────────────────────

export default class FoundationModelsExtension extends AIEngine {
  readonly provider: string = 'foundation-models'
  readonly providerId: string = 'foundation-models'

  /** Seconds before a streaming request is considered timed out. */
  timeout: number = 300

  /**
   * Foundation Models in `atomic-chat-core` (PLAN.md §4). The core starts and stops the server and
   * runs its `--check`; there are no settings to hand over.
   */
  private readonly core = createCoreRuntime('foundation-models', ((
    command,
    args
  ) =>
    args === undefined ? invoke(command) : invoke(command, args)) as Invoke)

  /** The running server as the core reports it now, or `null`. */
  private async findSession(): Promise<CoreSessionSummary | null> {
    return (await this.core.findSession(APPLE_MODEL_ID)) ?? null
  }

  // ── Lifecycle ──────────────────────────────────────────────────────────────

  override async onLoad(): Promise<void> {
    super.onLoad() // registers into EngineManager

    // Check device eligibility and silently remove ourselves if not supported.
    // This prevents the provider from appearing in the UI on ineligible devices.
    // The core answers with the server's own `--check` token (`available`,
    // `notEligible`, `appleIntelligenceNotEnabled`, `modelNotReady`,
    // `unavailable`, `binaryNotFound`). The call attaches to — or starts — the
    // core first, so an unreachable core hides the provider like a failed check.
    try {
      const availability = await this.core.foundationModelsAvailability()
      if (availability !== 'available') {
        logger.warn(
          `Foundation Models not available on this device (status: ${availability}). ` +
            'Hiding provider.'
        )
        EngineManager.instance().engines.delete(this.provider)
      }
    } catch (err) {
      logger.warn(
        'Could not determine Foundation Models availability — hiding provider.',
        describeCoreError(err)
      )
      EngineManager.instance().engines.delete(this.provider)
    }
  }

  override async onUnload(): Promise<void> {
    // The server belongs to the core; there is nothing to stop here.
  }

  // ── Model catalogue ────────────────────────────────────────────────────────

  override async list(): Promise<modelInfo[]> {
    return [this.buildModelInfo()]
  }

  override async get(modelId: string): Promise<modelInfo | undefined> {
    if (modelId !== APPLE_MODEL_ID) return undefined
    return this.buildModelInfo()
  }

  private buildModelInfo(): modelInfo {
    return {
      id: APPLE_MODEL_ID,
      name: APPLE_MODEL_NAME,
      providerId: this.provider,
      port: 0,
      sizeBytes: 0,
      tags: ['on-device', 'apple-intelligence'],
      capabilities: ['tools'],
    }
  }

  // ── Session management ─────────────────────────────────────────────────────

  override async load(
    modelId: string,
    _overrideSettings?: any,
    _isEmbedding: boolean = false,
    _bypassAutoUnload: boolean = false
  ): Promise<SessionInfo> {
    if (modelId !== APPLE_MODEL_ID) {
      throw new Error(
        `Foundation Models extension only supports model '${APPLE_MODEL_ID}', got '${modelId}'`
      )
    }

    // Return existing session if already running
    const existing = await this.findSession()
    if (existing) {
      logger.info(
        'Foundation Models server already running on port',
        existing.port
      )
      return this.toSessionInfo(existing)
    }

    try {
      return this.toSessionInfo(await this.core.load(APPLE_MODEL_ID))
    } catch (err) {
      const reason = describeCoreError(err)
      logger.error('Failed to start Foundation Models server in the core:', reason)
      throw new Error(reason)
    }
  }

  override async unload(_modelId: string): Promise<UnloadResult> {
    const session = await this.findSession()
    if (!session) {
      logger.warn('No active Foundation Models session to unload')
      return { success: false, error: 'No active session found' }
    }

    try {
      return await this.core.unload(APPLE_MODEL_ID)
    } catch (err) {
      return { success: false, error: describeCoreError(err) }
    }
  }

  // ── Inference ──────────────────────────────────────────────────────────────

  override async chat(
    opts: chatCompletionRequest,
    abortController?: AbortController
  ): Promise<chatCompletion | AsyncIterable<chatCompletionChunk>> {
    const session = await this.findSession()
    if (!session) {
      throw new Error(
        'Apple Foundation Model is not loaded. Please load the model first.'
      )
    }

    // The core drops a dead server itself, so a session it still reports is alive as far as it
    // knows; the health check catches one that stopped answering since.
    try {
      await fetch(`http://localhost:${session.port}/health`)
    } catch {
      throw new Error(
        'Apple Foundation Model server is not responding. Please reload the model.'
      )
    }

    const url = `http://localhost:${session.port}/v1/chat/completions`
    const headers: HeadersInit = {
      'Content-Type': 'application/json',
      'Authorization': `Bearer ${session.api_key}`,
    }
    const body = JSON.stringify(opts)

    if (opts.stream) {
      return this.handleStreamingResponse(url, headers, body, abortController)
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: abortController?.signal,
    })

    if (!response.ok) {
      const errData = await response.json().catch(() => null)
      throw new Error(
        `Foundation Models API request failed (${response.status}): ${JSON.stringify(errData)}`
      )
    }

    return (await response.json()) as chatCompletion
  }

  private async *handleStreamingResponse(
    url: string,
    headers: HeadersInit,
    body: string,
    abortController?: AbortController
  ): AsyncIterable<chatCompletionChunk> {
    const combinedController = new AbortController()
    const timeoutId = setTimeout(
      () => combinedController.abort(new Error('Request timed out')),
      this.timeout * 1000
    )

    if (abortController?.signal) {
      if (abortController.signal.aborted) {
        combinedController.abort(abortController.signal.reason)
      } else {
        abortController.signal.addEventListener(
          'abort',
          () => combinedController.abort(abortController.signal.reason),
          { once: true }
        )
      }
    }

    const response = await fetch(url, {
      method: 'POST',
      headers,
      body,
      signal: combinedController.signal,
    }).finally(() => clearTimeout(timeoutId))

    if (!response.ok) {
      const errData = await response.json().catch(() => null)
      throw new Error(
        `Foundation Models streaming request failed (${response.status}): ${JSON.stringify(errData)}`
      )
    }

    if (!response.body) {
      throw new Error('Response body is null')
    }

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

          if (trimmed.startsWith('data: ')) {
            try {
              const data = JSON.parse(trimmed.slice(6)) as chatCompletionChunk
              yield data
            } catch (e) {
              logger.error('Error parsing Foundation Models stream JSON:', e)
              throw e
            }
          } else if (trimmed.startsWith('error: ')) {
            const errObj = JSON.parse(trimmed.slice(7))
            throw new Error(errObj.message ?? 'Unknown streaming error')
          }
        }
      }
    } finally {
      reader.releaseLock()
    }
  }

  // ── Unsupported operations ─────────────────────────────────────────────────
  // Foundation Models are built into the OS — there are no files to manage.

  override async delete(_modelId: string): Promise<void> {
    throw new Error(
      'Apple Foundation Models are part of the operating system and cannot be deleted from Jan.'
    )
  }

  override async update(
    _modelId: string,
    _model: Partial<modelInfo>
  ): Promise<void> {
    throw new Error(
      'Apple Foundation Models are managed by the OS and cannot be updated from Jan.'
    )
  }

  override async import(_modelId: string, _opts: ImportOptions): Promise<void> {
    throw new Error(
      'Apple Foundation Models are built into the OS — there is nothing to import.'
    )
  }

  override async abortImport(_modelId: string): Promise<void> {
    // No download to abort — the model is managed by the OS.
  }

  override async getLoadedModels(): Promise<string[]> {
    const session = await this.findSession()
    return session ? [APPLE_MODEL_ID] : []
  }

  override async isToolSupported(_modelId: string): Promise<boolean> {
    // The Foundation Models framework supports function calling.
    return true
  }

  // ── Helpers ────────────────────────────────────────────────────────────────

  /**
   * Map the session the core reports to the `@janhq/core` SessionInfo shape. The server has no
   * model file, and the core's extra fields (provider, device) are not part of the engine contract.
   */
  private toSessionInfo(session: CoreSessionInfo): SessionInfo {
    return {
      pid: session.pid,
      port: session.port,
      model_id: session.model_id,
      model_path: '',
      is_embedding: false,
      api_key: session.api_key,
    }
  }
}
