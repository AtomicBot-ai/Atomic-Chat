import { type UIMessage } from '@ai-sdk/react'
import {
  convertToModelMessages,
  streamText,
  NoSuchToolError,
  type ChatRequestOptions,
  type ChatTransport,
  type LanguageModel,
  type ModelMessage,
  type UIMessageChunk,
  type Tool,
  type LanguageModelUsage,
  type TextStreamPart,
} from 'ai'
import { repairToolCallArguments } from './repairToolCall'
import { prepareToolResultImagesForModel } from './toolResultImages'
import {
  buildToolsRecord,
  splitAnthropicSerialToolUse,
} from './custom-chat-transport-helpers'
import type { MCPTool } from '@/types/completion'

/// Hugging Face special-token convention (`<|im_end|>`, `<|eot_id|>`,
/// `<|endoftext|>`, etc.). Some MLX backends — most visibly the DFlash
/// custom `stream_generate` path — leak the EOS marker as plain text in
/// the final delta instead of using it purely as a stop signal. These
/// markers never appear in well-formed assistant output, so we strip
/// them unconditionally before the chunk reaches the UI or the saved
/// message body.
const SPECIAL_TOKEN_REGEX = /<\|[a-zA-Z0-9_]+\|>/g

/// `streamText` transform that scrubs the special-token markers from
/// every `text-delta`. We pass `unknown` for `TOOLS` because the
/// transform doesn't introspect tools.
const stripSpecialTokensTransform = () =>
  new TransformStream<TextStreamPart<never>, TextStreamPart<never>>({
    transform(chunk, controller) {
      if (chunk.type === 'text-delta') {
        const cleaned = chunk.text.replace(SPECIAL_TOKEN_REGEX, '')
        if (cleaned.length === 0) {
          /// Emit a whitespace delta so the UI shows streaming state while
          /// reasoning / special-token-only prefixes are stripped.
          controller.enqueue({ ...chunk, text: ' ' })
          return
        }
        controller.enqueue({ ...chunk, text: cleaned })
        return
      }
      controller.enqueue(chunk)
    },
  })
import { useServiceStore } from '@/hooks/useServiceHub'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { SYSTEM_SERVER_KEYS } from '@/constants/mcp-connectors'
import { ModelFactory } from './model-factory'
import { useModelProvider } from '@/hooks/useModelProvider'
import { getSamplingParamsForThread } from '@/lib/samplingParams'
import { withRecommendedSampling } from '@/lib/predefinedParams'
import { buildReasoningRequestFields } from '@/lib/reasoning-effort'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useThreads } from '@/hooks/useThreads'
import { useAttachments } from '@/hooks/useAttachments'
import { useAppState } from '@/hooks/useAppState'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, VectorDBExtension } from '@janhq/core'
import { ttftMark } from '@/lib/ttft-timing'
import {
  growModelContext,
  readAutoIncreaseCtx,
  readModelCtxLen,
} from '@/lib/context-size'
import {
  DEFAULT_OUTPUT_RESERVE_TOKENS,
  PREFLIGHT_CTX_THRESHOLD,
  estimatePromptTokensHeuristic,
  estimateToolsTokens,
  toOpenAiMessages,
  toOpenAiTools,
} from '@/lib/prompt-size'
import { OUT_OF_CONTEXT_SIZE } from '@/utils/error'
import { summarizeToolCost } from '@/lib/tool-cost'
import { extractModelErrorMessage } from '@/lib/modelErrorMessage'
import {
  collectSkillNamesFromMessages,
  composeSystemMessage,
  loadChatSkillDetails,
  renderChatSkillsBlock,
} from '@/lib/chat-skill-injection'
import type { AgentSkillDetail } from '@/services/agent/skills'
import type { ServiceHub } from '@/services'
import { ensureRemoteProviderReady } from '@/utils/ensureRemoteProviderReady'
import {
  isLocalProvider as isLocalProviderName,
  isSubscriptionProvider,
} from '@/utils/registerRemoteProvider'

/// Local inference backends (mlx, llamacpp, llamacpp-upstream,
/// foundation-models) get special handling at the `streamText` boundary:
///   * when tools are also active, the assistant system prompt is not passed
///     as a `system` message — gemma-4 and similar local models reliably
///     auto-emit a chain-of-thought block whenever the rendered prompt
///     contains BOTH a system message and tools, even with
///     `chat_template_kwargs.enable_thinking=false`. To avoid silently losing
///     the user's instructions they are instead folded into the first user
///     message (see foldSystemIntoFirstUserMessage). When no tools are active
///     there is no CoT risk, so the system prompt is sent normally.
/// Tool inclusion is **independent of the reasoning toggle** for all
/// providers: tools are forwarded whenever the tools on/off setting has
/// them enabled and the model supports tool calling.
/// Remote providers (OpenAI, Anthropic, …) are unaffected.
const LOCAL_INFERENCE_PROVIDERS = new Set<string>([
  'mlx',
  'llamacpp',
  'llamacpp-upstream',
  'foundation-models',
])

/// Map an audio MIME type to the `format` string expected by the OpenAI-style
/// `input_audio` content part (which the MLX/omni backend consumes).
function audioMediaTypeToFormat(mediaType: string): string {
  const mt = mediaType.toLowerCase()
  if (mt.includes('mpeg') || mt.includes('mp3')) return 'mp3'
  if (mt.includes('wav') || mt.includes('wave')) return 'wav'
  if (mt.includes('ogg')) return 'ogg'
  if (mt.includes('flac')) return 'flac'
  // Fall back to the subtype (audio/<x> → <x>); the backend rejects unknowns.
  return mt.split('/')[1] ?? 'mp3'
}

/// Pull audio attachments out of the latest user message as `input_audio`
/// payloads. Audio is carried in the UI as a `file` part with an `audio/*`
/// media type, but the `@ai-sdk/openai-compatible` message converter only
/// understands `image/*` file parts and throws `UnsupportedFunctionalityError`
/// on anything else — so audio never travels through the normal message path.
/// Instead we extract it here and inject it at the MLX fetch layer.
export function extractAudioInputParts(
  messages: UIMessage[]
): Array<{ data: string; format: string }> {
  for (let i = messages.length - 1; i >= 0; i--) {
    const message = messages[i]
    if (message.role !== 'user') continue
    const parts = Array.isArray(message.parts) ? message.parts : []
    const audio: Array<{ data: string; format: string }> = []
    for (const part of parts as Array<Record<string, unknown>>) {
      if (
        part.type === 'file' &&
        typeof part.mediaType === 'string' &&
        part.mediaType.startsWith('audio/') &&
        typeof part.url === 'string'
      ) {
        const url = part.url as string
        const data = url.includes(',') ? url.slice(url.indexOf(',') + 1) : url
        audio.push({ data, format: audioMediaTypeToFormat(part.mediaType) })
      }
    }
    // Only the most recent user turn can carry freshly attached audio.
    return audio
  }
  return []
}

/// Whether a part may travel to the model as-is.
///
/// `image/*` is the only file part any converter we route to accepts:
/// `@ai-sdk/openai-compatible` (and `@ai-sdk/xai`) throw
/// `UnsupportedFunctionalityError` on everything else, and Anthropic — which
/// does understand `application/pdf` — would receive our `url`, a local
/// filesystem path the SDK cannot resolve, as the document body. Every other
/// attachment kind reaches the model through its own channel: audio as
/// `input_audio` at the MLX fetch layer (see `extractAudioInputParts`),
/// documents as text folded in by `mapUserInlineAttachments` or retrieved by
/// the RAG tools. So a non-image file part is never information — only a way
/// to break the request.
function isModelSupportedPart(part: unknown): boolean {
  const candidate = part as { type?: unknown; mediaType?: unknown }
  if (candidate.type !== 'file') return true
  return (
    typeof candidate.mediaType === 'string' &&
    candidate.mediaType.startsWith('image/')
  )
}

/// Return a copy of `messages` with every non-image `file` part removed.
/// Untouched messages are preserved by reference.
export function stripUnsupportedFileParts(messages: UIMessage[]): UIMessage[] {
  return messages.map((message) => {
    const parts = Array.isArray(message.parts) ? message.parts : []
    if (parts.every(isModelSupportedPart)) return message
    return {
      ...message,
      parts: parts.filter(isModelSupportedPart),
    } as UIMessage
  })
}

/// Fold the assistant system prompt into the first user message.
///
/// Local backends (gemma-4 et al.) reliably emit a spurious chain-of-thought
/// block when the rendered prompt contains BOTH a `system` message and tools,
/// so we cannot pass `system` alongside tools. Dropping it entirely, however,
/// means the user's assistant instructions are silently ignored whenever an
/// MCP/RAG tool is active. Instead we prepend the instructions to the first
/// user turn — the same position a system prompt occupies once gemma's chat
/// template merges it — so the model still honors them without the CoT trigger.
export function foldSystemIntoFirstUserMessage<
  T extends { role: string; content: unknown },
>(messages: T[], system: string): T[] {
  const idx = messages.findIndex((m) => m.role === 'user')
  if (idx === -1) {
    return [{ role: 'user', content: system } as unknown as T, ...messages]
  }

  const target = messages[idx]
  const content = target.content
  let newContent: unknown
  if (typeof content === 'string') {
    newContent = `${system}\n\n${content}`
  } else if (Array.isArray(content)) {
    newContent = [{ type: 'text', text: `${system}\n\n` }, ...content]
  } else {
    newContent = system
  }

  const copy = [...messages]
  copy[idx] = { ...target, content: newContent } as T
  return copy
}

/**
 * Drop the `tool-*` parts of assistant messages produced by the agent engine
 * (`metadata.agent_run`). Their tool names exist only in the Rust loop and
 * their states include values (`output-denied`) the AI-SDK converters do not
 * accept, so on a mixed-engine thread a fallback turn would otherwise send
 * unknown `tool_use` blocks to the provider. The text and reasoning survive —
 * that is the part of the exchange the next turn needs.
 */
export function stripAgentRunToolParts<T extends UIMessage>(
  messages: T[]
): T[] {
  return messages.map((message) => {
    const metadata = message.metadata as Record<string, unknown> | undefined
    if (!metadata?.agent_run) return message
    const parts = message.parts?.filter(
      (part) => !part.type.startsWith('tool-') && part.type !== 'dynamic-tool'
    )
    if (!parts || parts.length === (message.parts?.length ?? 0)) return message
    return { ...message, parts }
  })
}

export function shouldSuppressToolsForUpstreamDflash(
  providerId: string,
  settings: readonly ProviderSetting[] | undefined
): boolean {
  return (
    providerId === 'llamacpp-upstream' &&
    settings?.some(
      (setting) =>
        setting.key === 'dflash' && setting.controller_props.value === true
    ) === true
  )
}

export function withUpstreamDflashSampling(
  providerId: string,
  settings: readonly ProviderSetting[] | undefined,
  params: Record<string, unknown>
): Record<string, unknown> {
  if (!shouldSuppressToolsForUpstreamDflash(providerId, settings)) return params
  return {
    ...params,
    temperature: 0,
    top_k: 1,
    repeat_penalty: 1,
    presence_penalty: 0,
    frequency_penalty: 0,
  }
}

export function withUpstreamDflashReasoningOverride(
  providerId: string,
  settings: readonly ProviderSetting[] | undefined,
  override: Record<string, unknown>
): Record<string, unknown> {
  if (!shouldSuppressToolsForUpstreamDflash(providerId, settings)) {
    return override
  }

  const existingTemplateKwargs =
    typeof override.chat_template_kwargs === 'object' &&
    override.chat_template_kwargs !== null &&
    !Array.isArray(override.chat_template_kwargs)
      ? (override.chat_template_kwargs as Record<string, unknown>)
      : {}

  return {
    ...override,
    chat_template_kwargs: {
      ...existingTemplateKwargs,
      enable_thinking: false,
    },
    reasoning_budget_tokens: 0,
  }
}

export type TokenUsageCallback = (
  usage: LanguageModelUsage,
  messageId: string
) => void
export type StreamingTokenSpeedCallback = (
  tokenCount: number,
  elapsedMs: number
) => void

export function resolveTokenSpeed({
  providerId,
  providerReportedSpeed,
  outputTokens,
  durationSec,
}: {
  providerId: string
  providerReportedSpeed: number
  outputTokens: number
  durationSec: number
}): number {
  if (providerReportedSpeed > 0) return providerReportedSpeed

  // The ChatGPT subscription bridge receives Responses API `output_tokens`,
  // which may include hidden reasoning, but it can time only visible text or
  // reasoning-summary deltas. Dividing those unlike values produced impossible
  // rates for short or reasoning-heavy turns. The subscription endpoint does
  // not expose decode timing, so leave TPS unavailable instead of fabricating
  // a wall-clock estimate.
  if (isSubscriptionProvider(providerId)) return 0

  if (durationSec > 0 && outputTokens > 0) {
    return outputTokens / durationSec
  }

  return 0
}

export type OnFinishCallback = (params: {
  message: UIMessage
  isAbort?: boolean
}) => void
export type OnToolCallCallback = (params: {
  toolCall: { toolCallId: string; toolName: string; input: unknown }
}) => void

/**
 * Wraps a UIMessageChunk stream so that when the first `text-start` chunk
 * arrives, a `text-delta` carrying `prefixText` is immediately injected into
 * the same text block. This makes the new message show the partial content
 * right away while continuation tokens stream in after it.
 */
function prependTextDeltaToUIStream(
  stream: ReadableStream<UIMessageChunk>,
  prefixText: string
): ReadableStream<UIMessageChunk> {
  const reader = stream.getReader()
  let prefixEmitted = false
  return new ReadableStream<UIMessageChunk>({
    async pull(controller) {
      try {
        const { done, value } = await reader.read()
        if (done) {
          controller.close()
          return
        }
        controller.enqueue(value)
        if (
          !prefixEmitted &&
          (value as { type: string }).type === 'text-start'
        ) {
          prefixEmitted = true
          const id = (value as { type: 'text-start'; id: string }).id
          controller.enqueue({
            type: 'text-delta',
            id,
            delta: prefixText,
          } as UIMessageChunk)
        }
      } catch (error) {
        controller.error(error)
      }
    },
    cancel() {
      reader.cancel()
    },
  })
}

export class CustomChatTransport implements ChatTransport<UIMessage> {
  public model: LanguageModel | null = null
  private tools: Record<string, Tool> = {}
  private onTokenUsage?: TokenUsageCallback
  private hasDocuments = false
  private modelSupportsTools = false
  private ragFeatureAvailable = false
  private systemMessage?: string
  private serviceHub: ServiceHub | null
  private threadId?: string
  private continueFromContent: string | null = null
  private toolsCacheKey = ''
  private toolsCacheValid = false
  // Invoked-skill bodies, memoized for the transport's (per-thread) lifetime;
  // null marks a skill known to be unusable on the chat pipeline.
  private skillDetailCache = new Map<string, AgentSkillDetail | null>()

  constructor(systemMessage?: string, threadId?: string) {
    this.systemMessage = systemMessage
    this.threadId = threadId
    this.serviceHub = useServiceStore.getState().serviceHub
    // Tools will be loaded when updateRagToolsAvailability is called with model capabilities
  }

  updateSystemMessage(systemMessage: string | undefined) {
    this.systemMessage = systemMessage
  }

  /** Thread this transport is bound to. RAG/project lookups key off it. */
  getThreadId(): string | undefined {
    return this.threadId
  }

  setOnTokenUsage(callback: TokenUsageCallback | undefined) {
    this.onTokenUsage = callback
  }

  /**
   * Update RAG tools availability based on thread metadata and model capabilities
   * @param hasDocuments - Whether the thread has documents attached
   * @param modelSupportsTools - Whether the current model supports tool calling
   * @param ragFeatureAvailable - Whether RAG features are available on the platform
   */
  async updateRagToolsAvailability(
    hasDocuments: boolean,
    modelSupportsTools: boolean,
    ragFeatureAvailable: boolean
  ) {
    this.hasDocuments = hasDocuments
    this.modelSupportsTools = modelSupportsTools
    this.ragFeatureAvailable = ragFeatureAvailable

    // Update tools based on current state
    await this.refreshTools()
  }

  /**
   * Refresh tools based on current state
   * Reloads both RAG and MCP tools and merges them
   * Filters out disabled tools based on thread settings
   * @private
   */
  invalidateToolsCache() {
    this.toolsCacheValid = false
  }

  private buildToolsCacheKey(
    disabledToolKeys: string[],
    hasDocuments: boolean,
    ragFeatureAvailable: boolean,
    modelSupportsTools: boolean
  ): string {
    const mcp = [...useAppState.getState().mcpToolNames].sort().join(',')
    const rag = [...useAppState.getState().ragToolNames].sort().join(',')
    const muted = [...this.mutedServersForThread()].sort().join(',')
    // The cost report is measured against the selected model's window, so
    // a context change must rebuild it even when the tool set is unchanged.
    const ctxLen = readModelCtxLen(useModelProvider.getState().selectedModel)
    return [
      this.threadId ?? '',
      hasDocuments,
      ragFeatureAvailable,
      modelSupportsTools,
      disabledToolKeys.join(','),
      muted,
      ctxLen ?? '',
      mcp,
      rag,
    ].join('|')
  }

  /** Connectors the user switched off for this chat (see `useToolAvailable`). */
  private mutedServersForThread(): string[] {
    const store = useToolAvailable.getState()
    return this.threadId
      ? store.getMutedServersForThread(this.threadId)
      : store.getDefaultMutedServers()
  }

  async refreshTools(force = false) {
    if (!this.serviceHub) {
      this.tools = {}
      this.toolsCacheValid = false
      return
    }

    const getDisabledToolsForThread =
      useToolAvailable.getState().getDisabledToolsForThread
    const disabledToolKeys = this.threadId
      ? getDisabledToolsForThread(this.threadId)
      : useToolAvailable.getState().getDefaultDisabledTools()

    const selectedModel = useModelProvider.getState().selectedModel
    const modelSupportsTools =
      selectedModel?.capabilities?.includes('tools') ?? this.modelSupportsTools

    let hasDocuments = this.hasDocuments
    let ragFeatureAvailable = this.ragFeatureAvailable

    if (!hasDocuments && this.threadId) {
      const thread = useThreads.getState().threads[this.threadId]
      hasDocuments = Boolean(thread?.metadata?.hasDocuments)
    }
    if (!ragFeatureAvailable) {
      ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
    }

    const cacheKey = this.buildToolsCacheKey(
      disabledToolKeys,
      hasDocuments,
      ragFeatureAvailable,
      modelSupportsTools
    )
    if (!force && this.toolsCacheValid && cacheKey === this.toolsCacheKey) {
      return
    }

    let ragTools: MCPTool[] = []
    let mcpTools: MCPTool[] = []

    if (modelSupportsTools) {
      if (!hasDocuments && this.threadId) {
        const thread = useThreads.getState().threads[this.threadId]
        const hasThreadDocuments = Boolean(thread?.metadata?.hasDocuments)

        const projectId = thread?.metadata?.project?.id
        if (projectId) {
          try {
            const ext = ExtensionManager.getInstance().get<VectorDBExtension>(
              ExtensionTypeEnum.VectorDB
            )
            if (ext?.listAttachmentsForProject) {
              const projectFiles =
                await ext.listAttachmentsForProject(projectId)
              hasDocuments = hasThreadDocuments || projectFiles.length > 0
            }
          } catch (error) {
            console.warn('Failed to check project files:', error)
            hasDocuments = hasThreadDocuments
          }
        } else {
          hasDocuments = hasThreadDocuments
        }
      }

      if (!ragFeatureAvailable) {
        ragFeatureAvailable = Boolean(useAttachments.getState().enabled)
      }

      // Load RAG tools if documents are available
      if (hasDocuments && ragFeatureAvailable) {
        try {
          const availableRagTools = await this.serviceHub.rag().getTools()
          if (Array.isArray(availableRagTools)) {
            ragTools = availableRagTools as MCPTool[]
          }
        } catch (error) {
          console.warn('Failed to load RAG tools:', error)
        }
      }

      // Read MCP tools from the global store (populated once at app
      // startup by useTools and refreshed on MCP_UPDATE events). Avoids a
      // cold ~1.8s round-trip into the MCP service on every new thread's
      // first sendMessages call.
      try {
        const availableMcpTools = useAppState.getState().tools
        if (Array.isArray(availableMcpTools)) {
          mcpTools = availableMcpTools
        }
      } catch (error) {
        console.warn('Failed to load MCP tools:', error)
      }
    }

    // System servers (filesystem, fetch, …) are agent-mode tooling: the
    // agent engine reads them from its own catalog, a chat never sends them.
    const muted = new Set([
      ...this.mutedServersForThread(),
      ...SYSTEM_SERVER_KEYS,
    ])
    const audibleMcpTools = mcpTools.filter((tool) => !muted.has(tool.server))

    this.tools = buildToolsRecord(ragTools, audibleMcpTools, disabledToolKeys)
    this.toolsCacheKey = cacheKey
    this.toolsCacheValid = true

    // What the tool block costs, per connector, for the plugins menu and the
    // composer hint. Measured on what is actually sent (muted/disabled tools
    // excluded), against the selected model's context window.
    const disabled = new Set(disabledToolKeys)
    const sentTools = audibleMcpTools.filter(
      (tool) => !disabled.has(`${tool.server || 'unknown'}::${tool.name}`)
    )
    useAppState
      .getState()
      .setToolCostReport(
        this.threadId ?? '',
        summarizeToolCost(
          modelSupportsTools ? sentTools : [],
          readModelCtxLen(selectedModel)
        )
      )
  }

  /**
   * Get current tools
   */
  getTools(): Record<string, Tool> {
    return this.tools
  }

  /**
   * Set partial assistant content to send as a prefill on the next request,
   * so the model continues generation from where it left off.
   */
  setContinueFromContent(content: string) {
    this.continueFromContent = content
  }

  /** `chat_template_kwargs` of the last created model (reasoning on/off). */
  private lastChatTemplateKwargs: Record<string, unknown> | undefined

  /** Size of the last prepared prompt, for diagnostics / telemetry. */
  lastPromptSize:
    | {
        promptTokens: number
        toolTokens: number
        ctxLen: number
        measured: boolean
      }
    | undefined

  /**
   * Estimate (or, for llama.cpp, measure) the prompt and grow the model's
   * context window once when it would not fit. Returns silently on any
   * failure — the reactive error path in the thread route remains the
   * safety net. Throws a context-limit error when the ladder is already at
   * the model's maximum so the request is not sent into a window it cannot
   * fit.
   */
  private async ensureContextFits(args: {
    providerId: string
    modelId: string
    provider: ProviderObject | undefined
    system: string | undefined
    messages: ModelMessage[]
    tools: Record<string, Tool> | undefined
    maxOutputTokens: number | undefined
    recreateModel: () => Promise<void>
    abortSignal: AbortSignal | undefined
  }): Promise<void> {
    const selectedModel = useModelProvider.getState().selectedModel
    if (!selectedModel || selectedModel.id !== args.modelId) return
    if (!readAutoIncreaseCtx(selectedModel)) return
    const ctxLen = readModelCtxLen(selectedModel)
    if (!ctxLen || !this.serviceHub) return

    const heuristic = estimatePromptTokensHeuristic({
      system: args.system,
      messages: args.messages,
      tools: args.tools,
    })
    let promptTokens = heuristic
    let measured = false
    if (
      args.providerId === 'llamacpp' ||
      args.providerId === 'llamacpp-upstream'
    ) {
      const exact = await ModelFactory.countLocalPromptTokens(
        args.providerId,
        args.modelId,
        args.provider,
        {
          messages: toOpenAiMessages({
            system: args.system,
            messages: args.messages,
          }),
          tools: toOpenAiTools(args.tools),
          ...(this.lastChatTemplateKwargs
            ? { chat_template_kwargs: this.lastChatTemplateKwargs }
            : {}),
        }
      )
      if (exact !== null) {
        promptTokens = exact
        measured = true
      }
    }
    if (args.abortSignal?.aborted) return

    const needed =
      promptTokens + (args.maxOutputTokens ?? DEFAULT_OUTPUT_RESERVE_TOKENS)
    const limit = ctxLen * PREFLIGHT_CTX_THRESHOLD
    this.lastPromptSize = {
      promptTokens,
      toolTokens: estimateToolsTokens(args.tools),
      ctxLen,
      measured,
    }
    if (needed <= limit) return

    const minCtxLen = Math.ceil(needed / PREFLIGHT_CTX_THRESHOLD)
    console.info(
      `[chat] prompt ${promptTokens} tokens (${measured ? 'measured' : 'estimated'}) + ${needed - promptTokens} reserved does not fit ctx ${ctxLen}; growing to >= ${minCtxLen}`
    )
    const result = await growModelContext({
      providerId: args.providerId,
      modelId: args.modelId,
      serviceHub: this.serviceHub,
      minCtxLen,
    })
    if (!result.ok) {
      if (result.reason === 'at_max') {
        throw new Error(
          `${OUT_OF_CONTEXT_SIZE} The prompt needs about ${needed} tokens (${this.lastPromptSize.toolTokens} of them are tool definitions) but the model's maximum context is ${result.max ?? result.from}. Disable some connectors for this chat or shorten the conversation.`
        )
      }
      return
    }
    if (args.abortSignal?.aborted) return
    await args.recreateModel()
    this.lastPromptSize = { ...this.lastPromptSize, ctxLen: result.to }
  }

  async sendMessages(
    options: {
      chatId: string
      messages: UIMessage[]
      abortSignal: AbortSignal | undefined
    } & {
      trigger: 'submit-message' | 'regenerate-message'
      messageId: string | undefined
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk>> {
    const requestStartedAt = Date.now()
    ttftMark('gammaStart')
    await this.refreshTools()
    ttftMark('gammaEnd')

    // Capture the effective provider name early so the Anthropic serial
    // tool-use repair later uses the same value that was used to create the
    // model, even if the user switches provider mid-request.
    const modelId = useModelProvider.getState().selectedModel?.id
    const providerId = useModelProvider.getState().selectedProvider
    const effectiveProviderName = providerId
    const provider = useModelProvider.getState().getProviderByName(providerId)
    // Re-creates `this.model` against the provider store's current settings
    // (used after a pre-flight context growth reloads the local session).
    let recreateModel: (() => Promise<void>) | undefined
    if (this.serviceHub && modelId && provider) {
      try {
        const updatedProvider = useModelProvider
          .getState()
          .getProviderByName(providerId)

        // Sampling parameters of the assistant this chat is bound to, injected
        // verbatim into local-backend request bodies by ModelFactory. For
        // Gemma 4 QAT, Google's recommended sampler (temp 1.0 / top_p 0.95 /
        // top_k 64) is layered on at request time unless the user has tuned
        // that assistant's sampling — non-destructive, follows the active model.
        const sampling = getSamplingParamsForThread(this.threadId)
        const providerSettings = updatedProvider?.settings ?? provider.settings
        const inferenceParams = withUpstreamDflashSampling(
          providerId,
          providerSettings,
          withRecommendedSampling(modelId, sampling.params, sampling.overridden)
        )

        // Global "Disable reasoning" setting — best-effort: dispatch the
        // provider-specific flag that skips the thinking phase. Unknown keys
        // are silently ignored by most providers, but we still branch per
        // provider to stay safe with stricter APIs (e.g. Anthropic).
        //
        // The override is kept SEPARATE from `inferenceParams` so local-only
        // fields (top_k, repeat_penalty, …) never leak into cloud-provider
        // request bodies. See ModelFactory for the fetch wiring.
        const { disableReasoning, reasoningBudget } =
          useGeneralSetting.getState()
        const reasoningOverride: Record<string, unknown> = {}
        const reasoningControls =
          useModelProvider.getState().selectedModel?.reasoning
        if (disableReasoning || reasoningBudget === 'off') {
          switch (effectiveProviderName) {
            case 'llamacpp':
            case 'llamacpp-upstream':
            case 'mlx': {
              // Some templates (e.g. Hunyuan 3) have no `enable_thinking` and
              // skip thinking only through their own effort value.
              const offValue = reasoningControls?.offValue
              reasoningOverride.chat_template_kwargs = {
                enable_thinking: false,
                ...(offValue ? { reasoning_effort: offValue } : {}),
              }
              if (offValue && effectiveProviderName === 'mlx') {
                // mlx-vlm forwards only a top-level `reasoning_effort` to the
                // template; its `chat_template_kwargs` reader ignores the key.
                reasoningOverride.reasoning_effort = offValue
              }
              break
            }
            case 'anthropic':
              reasoningOverride.thinking = { type: 'disabled' }
              break
            case 'openai':
              reasoningOverride.reasoning_effort = 'minimal'
              break
            case 'xai':
              reasoningOverride.reasoning_effort = 'low'
              break
            case 'google':
            case 'gemini':
              reasoningOverride.reasoning_effort = 'minimal'
              reasoningOverride.extra_body = {
                google: { thinking_config: { thinking_budget: 0 } },
              }
              break
            case 'moonshot':
              // Moonshot (Kimi) accepts only high|low|medium|max|xhigh; rejects
              // `minimal`. `low` is the closest analogue to "skip thinking".
              reasoningOverride.reasoning_effort = 'low'
              break
            default:
              // Unknown / user-added custom providers: do NOT inject
              // `reasoning_effort` — strict OpenAI-compatible schemas
              // (e.g. Moonshot, some self-hosted gateways) reject unknown
              // variants like `minimal`. The chat_template_kwargs hint is
              // safe: most servers ignore unknown keys.
              reasoningOverride.chat_template_kwargs = {
                enable_thinking: false,
              }
          }
        } else if (
          effectiveProviderName === 'llamacpp' ||
          effectiveProviderName === 'llamacpp-upstream' ||
          effectiveProviderName === 'mlx'
        ) {
          Object.assign(
            reasoningOverride,
            buildReasoningRequestFields(
              reasoningBudget,
              effectiveProviderName,
              reasoningControls
            )
          )
        }
        const effectiveReasoningOverride = withUpstreamDflashReasoningOverride(
          providerId,
          providerSettings,
          reasoningOverride
        )
        const hasOverride = Object.keys(effectiveReasoningOverride).length > 0

        // Audio attachments (omni/audio-capable models, MLX backend) are
        // injected as `input_audio` at the MLX fetch layer rather than as
        // file parts — the OpenAI-compatible converter rejects audio file
        // parts. Only the MLX provider consumes them today.
        const audioInputParts =
          effectiveProviderName === 'mlx'
            ? extractAudioInputParts(options.messages)
            : []

        ttftMark('deltaStart')
        const effectiveProvider = updatedProvider ?? provider
        if (!isLocalProviderName(effectiveProvider.provider)) {
          await ensureRemoteProviderReady(effectiveProvider, this.serviceHub)
        }
        this.model = await ModelFactory.createModel(
          modelId,
          effectiveProvider,
          inferenceParams ?? {},
          hasOverride ? effectiveReasoningOverride : undefined,
          audioInputParts.length > 0 ? audioInputParts : undefined
        )
        ttftMark('deltaEnd')
        recreateModel = async () => {
          const fresh =
            useModelProvider.getState().getProviderByName(providerId) ??
            effectiveProvider
          this.model = await ModelFactory.createModel(
            modelId,
            fresh,
            inferenceParams ?? {},
            hasOverride ? effectiveReasoningOverride : undefined,
            audioInputParts.length > 0 ? audioInputParts : undefined
          )
        }
        this.lastChatTemplateKwargs =
          effectiveReasoningOverride.chat_template_kwargs as
            | Record<string, unknown>
            | undefined
      } catch (error) {
        console.error('Failed to create model:', error)
        throw new Error(
          `Failed to create model: ${extractModelErrorMessage(error)}`
        )
      }
    } else {
      throw new Error('ServiceHub not initialized or model/provider missing.')
    }

    // Fix for Anthropic serial tool-use (error 400): when an assistant message
    // contains tool parts interleaved with text parts (serial tool calls),
    // split it into separate messages so convertToModelMessages produces the
    // tool_use / tool_result pairing that the Claude API requires.
    // See: https://platform.claude.com/docs/en/agents-and-tools/tool-use/implement-tool-use#parallel-tool-use
    // Mixed-engine hygiene: agent-run tool parts never reach a chat request.
    const sanitizedMessages = stripAgentRunToolParts(options.messages)
    const messagesToConvert =
      effectiveProviderName === 'anthropic'
        ? splitAnthropicSerialToolUse(sanitizedMessages)
        : sanitizedMessages

    // Convert UI messages to model messages. Non-image file parts are stripped
    // first — the converters accept `image/*` and nothing else. Order matters:
    // `mapUserInlineAttachments` folds document text into the message before
    // the strip runs, and `extractAudioInputParts` ran earlier against the
    // untouched `options.messages`, so neither loses anything.
    let preparedMessages = stripUnsupportedFileParts(
      this.mapUserInlineAttachments(messagesToConvert)
    )
    // Local backends serialize tool results to a `role: "tool"` text message
    // (JSON.stringify), so an image in a tool result (e.g. an MCP screenshot
    // tool) would otherwise be sent as full base64 TEXT and flood the context
    // window — the root cause of ATO-208's MLX 400s. Strip the base64 out of
    // the model payload (placeholder) and, for vision models, re-attach the
    // image as a proper multimodal user message. Cloud providers are left
    // untouched (they have large contexts and handle this differently).
    if (LOCAL_INFERENCE_PROVIDERS.has(effectiveProviderName)) {
      const supportsVision =
        useModelProvider
          .getState()
          .selectedModel?.capabilities?.includes('vision') ?? false
      preparedMessages = prepareToolResultImagesForModel(preparedMessages, {
        supportsVision,
      })
    }
    const baseMessages = convertToModelMessages(preparedMessages)

    // If continuing a truncated response, append the partial assistant content as a
    // prefill so the model resumes from where it left off rather than regenerating.
    const continueContent = this.continueFromContent
    this.continueFromContent = null
    const modelMessages = continueContent
      ? [
          ...baseMessages,
          { role: 'assistant' as const, content: continueContent },
        ]
      : baseMessages

    // Local-providers (mlx, llamacpp, llamacpp-upstream, foundation-models):
    // when tools are also active we don't pass a `system` message (gemma-4 and
    // similar local models reliably auto-emit a chain-of-thought block whenever
    // the rendered prompt contains BOTH a system message and tools). Instead of
    // discarding the user's assistant instructions, they are folded into the
    // first user message below so the model still honors them. Without tools
    // there is no CoT risk, so the system prompt is forwarded normally.
    // See LOCAL_INFERENCE_PROVIDERS for rationale. Tool inclusion is
    // independent of the reasoning toggle and governed solely by the tools
    // on/off setting (via refreshTools -> useToolAvailable).
    const isLocalProvider = LOCAL_INFERENCE_PROVIDERS.has(effectiveProviderName)

    const hasTools = Object.keys(this.tools).length > 0
    const selectedModel = useModelProvider.getState().selectedModel
    const modelSupportsTools =
      selectedModel?.capabilities?.includes('tools') ?? this.modelSupportsTools
    const suppressToolsForDflash = shouldSuppressToolsForUpstreamDflash(
      effectiveProviderName,
      provider.settings
    )
    const shouldEnableTools =
      hasTools && modelSupportsTools && !suppressToolsForDflash

    // Skills invoked on this thread (via the composer's "/" menu, stamped on
    // user-message metadata) ride the system prompt — the chat counterpart of
    // the agent's `skill.view` loading. Reading them off `options.messages`
    // makes send, regenerate, edit and app-restart replay uniform.
    const invokedSkillNames = collectSkillNamesFromMessages(options.messages)
    const skillsBlock = renderChatSkillsBlock(
      await loadChatSkillDetails(
        invokedSkillNames,
        this.skillDetailCache,
        new Set([
          ...useAppState.getState().mcpToolNames,
          ...useAppState.getState().ragToolNames,
        ])
      )
    )
    const systemWithSkills = composeSystemMessage(
      this.systemMessage,
      skillsBlock
    )

    const dropSystemForTools =
      isLocalProvider && shouldEnableTools && !!systemWithSkills
    const effectiveSystemMessage = dropSystemForTools
      ? undefined
      : systemWithSkills

    // When we drop the `system` field for the gemma+tools CoT workaround, fold
    // the instructions into the first user message so they still reach the
    // model instead of being silently lost.
    const finalModelMessages =
      dropSystemForTools && systemWithSkills
        ? foldSystemIntoFirstUserMessage(modelMessages, systemWithSkills)
        : modelMessages

    // Track stream timing and token count for token speed calculation.
    // We start the clock on the *first generated delta* (text or reasoning),
    // not on the `start` event, so the wall-clock fallback measures decode
    // throughput rather than (TTFT + prefill + decode). Without this, long
    // system prompts and MTP/dflash spin-up artificially deflate the
    // displayed tokens/sec.
    let streamStartTime: number | undefined

    const maxOutputTokens = getSamplingParamsForThread(this.threadId).params
      ?.max_output_tokens as number | undefined

    // Pre-flight (local engines only): measure the rendered prompt — tool
    // schemas included — and grow the context window BEFORE the request
    // when it would not fit. Without this a long tool catalogue fails with
    // "exceeds the available context size", the model is reloaded, and the
    // whole prompt is regenerated; with it there is one reload and no error.
    if (isLocalProvider && modelId) {
      await this.ensureContextFits({
        providerId: effectiveProviderName,
        modelId,
        provider,
        system: effectiveSystemMessage,
        messages: finalModelMessages,
        tools: shouldEnableTools ? this.tools : undefined,
        maxOutputTokens,
        recreateModel,
        abortSignal: options.abortSignal,
      })
    }

    const result = streamText({
      model: this.model,
      messages: finalModelMessages,
      abortSignal: options.abortSignal,
      tools: shouldEnableTools ? this.tools : undefined,
      toolChoice: shouldEnableTools ? 'auto' : undefined,
      system: effectiveSystemMessage,
      maxOutputTokens,
      // Local engines answer a prompt that does not fit with a fast,
      // deterministic error; retrying it (the SDK default for 5xx) only
      // delays the context-growth path. Cloud providers keep the default.
      maxRetries: isLocalProvider ? 0 : undefined,
      experimental_transform: stripSpecialTokensTransform,
      experimental_repairToolCall: async ({ toolCall, error }) => {
        if (NoSuchToolError.isInstance(error)) return null
        const repaired = repairToolCallArguments(toolCall.input)
        if (repaired === null) return null
        return { ...toolCall, input: repaired }
      },
    })

    let tokensPerSecond = 0
    let draftTokensTotal: number | null = null
    let draftTokensAccepted: number | null = null

    const uiStream = result.toUIMessageStream({
      messageMetadata: ({ part }) => {
        // Start the wall-clock timer on the first generated delta (text or
        // reasoning), NOT on `start` — the latter fires before prefill, so
        // including it would tank the fallback TPS on long prompts.
        if (
          !streamStartTime &&
          (part.type === 'text-delta' || part.type === 'reasoning-delta')
        ) {
          streamStartTime = Date.now()
        }

        if (part.type === 'finish-step') {
          const pm = part.providerMetadata?.providerMetadata as
            | Record<string, unknown>
            | undefined
          tokensPerSecond = (pm?.tokensPerSecond as number) || 0
          draftTokensTotal = (pm?.draftTokensTotal as number) ?? null
          draftTokensAccepted = (pm?.draftTokensAccepted as number) ?? null
        }

        // Add usage and token speed to metadata on finish
        if (part.type === 'finish') {
          const finishPart = part as {
            type: 'finish'
            totalUsage: LanguageModelUsage
            finishReason: string
          }
          const usage = finishPart.totalUsage
          const durationMs = streamStartTime ? Date.now() - streamStartTime : 0
          const durationSec = durationMs / 1000

          // Use provider's outputTokens, or llama.cpp completionTokens, or fall back to text delta count
          const outputTokens = usage?.outputTokens ?? 0
          const inputTokens = usage?.inputTokens

          // Prefer the provider-reported decode TPS (mlx-vlm `generation_tps`
          // or llama.cpp / dflash `predicted_per_second`). Fall back to a
          // wall-clock estimate measured from the first delta — but only if
          // the timer ever started AND we actually produced tokens (e.g. a
          // pure tool-call response yields 0 tokens and no delta, so the
          // fallback would otherwise divide by zero).
          const tokenSpeed = resolveTokenSpeed({
            providerId,
            providerReportedSpeed: tokensPerSecond,
            outputTokens,
            durationSec: streamStartTime === undefined ? 0 : durationSec,
          })

          return {
            finishReason: finishPart.finishReason,
            activityDurationMs: Math.max(0, Date.now() - requestStartedAt),
            // Provider-agnostic time to first token: `streamStartTime` is the
            // first generated delta, set above. The α→θ stage breakdown in
            // `ttft-timing` only spans the Tauri/proxy path, so this is the
            // value that is comparable across local and cloud providers.
            ttftMs: streamStartTime
              ? Math.max(0, streamStartTime - requestStartedAt)
              : null,
            // The model/provider a message was produced by was previously not
            // recorded anywhere, so a finished turn could not be attributed.
            modelId,
            providerId,
            usage: {
              inputTokens: inputTokens,
              outputTokens: outputTokens,
              totalTokens:
                usage?.totalTokens ?? (inputTokens ?? 0) + outputTokens,
            },
            ...(tokenSpeed > 0
              ? {
                  tokenSpeed: {
                    tokenSpeed: Math.round(tokenSpeed * 10) / 10, // Round to 1 decimal
                    tokenCount: outputTokens,
                    durationMs,
                    ...(draftTokensTotal != null && draftTokensTotal > 0
                      ? {
                          draftTokensTotal,
                          draftTokensAccepted: draftTokensAccepted ?? 0,
                        }
                      : {}),
                  },
                }
              : {}),
          }
        }

        return undefined
      },
      onError: (error) => {
        const errorMessage =
          error == null
            ? 'Unknown error'
            : typeof error === 'string'
              ? error
              : error instanceof Error
                ? error.message
                : JSON.stringify(error)

        return errorMessage
      },
      onFinish: ({ responseMessage }) => {
        // Call the token usage callback with usage data when stream completes
        if (responseMessage) {
          const metadata = responseMessage.metadata as
            | Record<string, unknown>
            | undefined
          const usage = metadata?.usage as LanguageModelUsage | undefined
          if (usage) {
            this.onTokenUsage?.(usage, responseMessage.id)
          }
        }
      },
    })

    // When continuing a truncated response, inject the partial content as the
    // very first text-delta so the new message immediately shows it and the
    // user sees a seamless continuation rather than an empty box.
    const finalStream = continueContent
      ? prependTextDeltaToUIStream(uiStream, continueContent)
      : uiStream

    return finalStream
  }

  async reconnectToStream(
    // eslint-disable-next-line @typescript-eslint/no-unused-vars
    _options: {
      chatId: string
    } & ChatRequestOptions
  ): Promise<ReadableStream<UIMessageChunk> | null> {
    // This function normally handles reconnecting to a stream on the backend, e.g. /api/chat
    // Since this project has no backend, we can't reconnect to a stream, so this is intentionally no-op.
    return null
  }

  /**
   *  Map user messages to include inline attachments in the message parts
   * @param messages
   * @returns
   */
  mapUserInlineAttachments(messages: UIMessage[]): UIMessage[] {
    return messages.map((message) => {
      if (message.role === 'user') {
        const metadata = message.metadata as
          | {
              inline_file_contents?: Array<{ name?: string; content?: string }>
            }
          | undefined
        const inlineFileContents = Array.isArray(metadata?.inline_file_contents)
          ? metadata.inline_file_contents.filter((f) => f?.content)
          : []
        // Tool messages have content as array of ToolResultPart
        if (inlineFileContents.length > 0) {
          if (message.parts.length > 0) {
            const inlineBlock = inlineFileContents
              .map((f) => `File: ${f.name || 'attachment'}\n${f.content ?? ''}`)
              .join('\n\n')
            const lastTextIdx = message.parts.reduce(
              (acc, part, index) => (part.type === 'text' ? index : acc),
              -1
            )
            if (lastTextIdx >= 0) {
              const parts = [...message.parts]
              const part = parts[lastTextIdx]
              if (part.type === 'text') {
                const base = part.text ?? ''
                parts[lastTextIdx] = {
                  type: 'text' as const,
                  text: base ? `${base}\n\n${inlineBlock}` : inlineBlock,
                }
              }
              message.parts = parts
            } else {
              message.parts = [
                ...message.parts,
                { type: 'text' as const, text: inlineBlock },
              ]
            }
          }
        }
      }

      return message
    })
  }
}
