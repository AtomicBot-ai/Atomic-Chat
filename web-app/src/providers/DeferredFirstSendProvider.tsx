import { useEffect, useRef, useState } from 'react'
import { generateId, type UIMessage } from 'ai'
import {
  ChatCompletionRole,
  MessageStatus,
  type ThreadMessage,
} from '@janhq/core'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { route } from '@/constants/routes'
import { useAppState } from '@/hooks/useAppState'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useAssistant } from '@/hooks/useAssistant'
import { useChat } from '@/hooks/use-chat'
import { useMessages } from '@/hooks/useMessages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { usePrompt } from '@/hooks/usePrompt'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { newUserThreadContent } from '@/lib/completion'
import { resolveAssistantForThread } from '@/lib/samplingParams'
import {
  executeChatToolCalls,
  shouldSendToolFollowUp,
  type ChatToolCall,
  type ChatToolOutput,
} from '@/lib/execute-chat-tool-calls'
import { extractContentPartsFromUIMessage } from '@/lib/messages'
import { downscaleToolResultContent } from '@/lib/toolResultImages'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { approveChatToolCall } from '@/lib/mcp-approval'
import {
  offeredChatExecToolNames,
  runChatExecToolCall,
} from '@/lib/chat-exec-tools'
import { useDeferredFirstSend } from '@/stores/deferred-first-send-store'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { switchToModel } from '@/utils/switchModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { composerThreadKey } from '@/lib/composer-thread-key'
import {
  attachmentTelemetry,
  beginChatTurn,
  captureChatRequest,
  captureChatResponse,
  contextTelemetry,
  currentChatTurn,
  responseShapeFromMessage,
  type ChatOutcome,
} from '@/lib/chat-telemetry'
import { type RouteReason } from '@/lib/agent-route'
import { resolveThreadExecutionRoute } from '@/lib/thread-execution-route'
import { classifyChatFailure, lengthBucket } from '@/lib/telemetry'
import { ttftBegin, ttftSnapshot } from '@/lib/ttft-timing'
import { DEFAULT_CTX_LEN } from '@/lib/context-size'

type Worker = {
  queueId: string
  threadId: string
  title: string
  prompt: string
  navigateWhenStarted: boolean
  systemMessage?: string
}

/** The send this provider made, until its `chat_response_received` is out. */
type SentTurn = {
  threadId: string
  turnId: string
  routeReason?: RouteReason
}

const selectedCtxLen = (): number | null =>
  (useModelProvider.getState().selectedModel?.settings?.ctx_len
    ?.controller_props?.value as number) ?? null

// Only the home composer queues a first send (ChatInput's `canRunFromRoot`).
const HOME_COMPOSER_KEY = composerThreadKey({ isComposer: true })

const matchesModelId = (candidate: string, expected: string) =>
  candidate === expected || candidate.replace(/\\/g, '/') === expected

/**
 * Completes the very first queued text message even when the user leaves the
 * home route while its model downloads. The generated chat session is the
 * same shared session ThreadDetail adopts when the user opens that sidebar
 * entry, so background progress is not thrown away on navigation.
 */
export function DeferredFirstSendProvider() {
  const queued = useDeferredFirstSend((state) => state.queued)
  const claimedId = useDeferredFirstSend((state) => state.claimedId)
  const clearQueue = useDeferredFirstSend((state) => state.clear)
  const providers = useModelProvider((state) => state.providers)
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const selectedModel = useModelProvider((state) => state.selectedModel)
  const activeModels = useAppState((state) => state.activeModels)
  const resumableDownloads = useDownloadStore(
    (state) => state.resumableDownloads
  )
  const serviceHub = useServiceHub()
  const navigate = useNavigate()
  const { t } = useTranslation()
  const [worker, setWorker] = useState<Worker | null>(null)
  const startingIdRef = useRef<string | null>(null)
  const sentThreadRef = useRef<string | null>(null)
  const toolCallsRef = useRef<ChatToolCall[]>([])
  const toolControllerRef = useRef<AbortController | null>(null)
  const addToolOutputRef = useRef<(output: ChatToolOutput) => void>(() => {})
  const sentTurnRef = useRef<SentTurn | null>(null)
  const turnErrorRef = useRef<unknown>(undefined)

  /**
   * The `chat_response_received` for the send below, built the way the thread
   * page builds it. The thread's Chat calls back into whichever page rendered
   * it last, so if the user opened the thread the page emits this instead,
   * under the same turn id; once that turn is no longer the thread's in-flight
   * one, there is nothing left to report here.
   */
  const captureTurnOutcome = ({
    message,
    messages,
    isAbort,
    isError,
  }: {
    message: UIMessage
    messages: UIMessage[]
    isAbort: boolean
    isError: boolean
  }) => {
    const turn = sentTurnRef.current
    if (!turn) return
    sentTurnRef.current = null
    if (currentChatTurn(turn.threadId) !== turn.turnId) return

    const error = turnErrorRef.current
    const meta = (message.metadata ?? {}) as Record<string, unknown>
    const usage = meta.usage as
      | { inputTokens?: number; outputTokens?: number }
      | undefined
    const ctxLen = selectedCtxLen()
    // Nothing here grows the context and continues, so a reply cut off at the
    // context limit is a stopped turn; `length` short of it is max_tokens.
    const outcome: ChatOutcome = isAbort
      ? 'aborted'
      : isError
        ? classifyChatFailure(error) === 'aborted'
          ? 'aborted'
          : 'error'
        : meta.finishReason === 'length' &&
            (usage?.inputTokens ?? 0) + (usage?.outputTokens ?? 0) >=
              (ctxLen ?? DEFAULT_CTX_LEN) * 0.9
          ? 'truncated_stopped'
          : 'success'
    const { ragToolNames, mcpToolNames } = useAppState.getState()
    const shape = responseShapeFromMessage(message, ragToolNames, mcpToolNames)
    const { selectedModel: model, selectedProvider: provider } =
      useModelProvider.getState()

    captureChatResponse({
      ...shape,
      ...attachmentTelemetry([]),
      ...contextTelemetry(shape.tokens_total as number | null, ctxLen),
      ...ttftSnapshot(),
      turn_id: turn.turnId,
      thread_id: turn.threadId,
      source: 'chat',
      engine: 'chat-transport',
      route_reason: turn.routeReason,
      outcome,
      error,
      model_id: (meta.modelId as string | undefined) ?? model?.id ?? null,
      provider: (meta.providerId as string | undefined) ?? provider ?? null,
      turn_index: messages.length,
      ctx_overflow: outcome === 'truncated_stopped',
      ctx_auto_increased: false,
    })
  }

  const { sendMessage, addToolOutput } = useChat({
    sessionId: worker?.threadId,
    sessionTitle: worker?.title,
    systemMessage: worker?.systemMessage,
    experimental_throttle: 50,
    onToolCall: ({ toolCall }) => {
      toolCallsRef.current.push({
        toolCallId: toolCall.toolCallId,
        toolName: toolCall.toolName,
        input:
          typeof toolCall.input === 'object' && toolCall.input !== null
            ? toolCall.input
            : {},
      })
    },
    onError: (error) => {
      // The AI SDK always follows this with `onFinish({ isError: true })`,
      // which reports the turn together with the reply it got.
      turnErrorRef.current = error
      console.error('[DeferredFirstSend] background send failed', error)
      toast.error(t('chat:replyGate.backgroundFailed'))
    },
    onFinish: ({ message, messages, isAbort, isError }) => {
      // A stop or a failure ends the turn; otherwise it ends once no tool call
      // is waiting for the automatic follow-up.
      if (isAbort || isError || toolCallsRef.current.length === 0) {
        captureTurnOutcome({ message, messages, isAbort, isError })
      }
      const current = worker
      if (!current || isAbort) return

      if (message.role === 'assistant') {
        const content = extractContentPartsFromUIMessage(message)
        if (content.length > 0) {
          const assistantMessage: ThreadMessage = {
            type: 'text',
            role: ChatCompletionRole.Assistant,
            content,
            id: message.id,
            object: 'thread.message',
            thread_id: current.threadId,
            status: MessageStatus.Ready,
            created_at: Date.now(),
            completed_at: Date.now(),
            metadata: (message.metadata ?? {}) as Record<string, unknown>,
          }
          const messages = useMessages
            .getState()
            .getMessages(current.threadId)
          if (messages.some((item) => item.id === message.id)) {
            useMessages.getState().updateMessage(assistantMessage)
          } else {
            useMessages.getState().addMessage(assistantMessage)
          }
        }
      }

      const pendingTools = toolCallsRef.current.splice(0)
      if (pendingTools.length === 0) {
        toolControllerRef.current = null
        setWorker(null)
        return
      }

      const controller = new AbortController()
      toolControllerRef.current = controller
      void executeChatToolCalls({
        toolCalls: pendingTools,
        signal: controller.signal,
        threadId: current.threadId,
        ragToolNames: useAppState.getState().ragToolNames,
        mcpToolNames: useAppState.getState().mcpToolNames,
        execToolNames: offeredChatExecToolNames(),
        approve: approveChatToolCall,
        callRagTool: (args) => serviceHub.rag().callTool(args),
        callMcpTool: (args) => serviceHub.mcp().callTool(args),
        callExecTool: (args) =>
          runChatExecToolCall({ service: serviceHub.chatExec(), ...args }),
        getProjectId: () => undefined,
        processOutput: (content) =>
          downscaleToolResultContent(
            content,
            useGeneralSetting.getState().maxImageSizePx
          ),
        addToolOutput: (output) => addToolOutputRef.current(output),
      }).catch((error) => {
        console.error('[DeferredFirstSend] tool call failed', error)
      })
    },
    sendAutomaticallyWhen: ({ messages }) =>
      shouldSendToolFollowUp(messages, toolControllerRef.current),
  })
  addToolOutputRef.current = addToolOutput

  useEffect(() => {
    if (
      queued?.downloadModelIds.some((id) => resumableDownloads.has(id))
    ) {
      clearQueue(queued.id)
    }
  }, [clearQueue, queued, resumableDownloads])

  // The import itself remains library-only. Only this exact queued model gets
  // selected and started, because pressing Send supplied explicit intent.
  useEffect(() => {
    if (!queued || worker || startingIdRef.current) return
    // The home composer owns the fast path and can hand the turn to the full
    // ThreadDetail flow. This provider is the fallback once navigation unmounts
    // that composer; standing down here also avoids two simultaneous starts.
    if (window.location.pathname === route.home) return

    for (const expectedId of queued.downloadModelIds) {
      const provider = providers.find((entry) =>
        entry.models.some((model) => matchesModelId(model.id, expectedId))
      )
      const model = provider?.models.find((entry) =>
        matchesModelId(entry.id, expectedId)
      )
      if (!provider || !model) continue

      startingIdRef.current = expectedId
      useModelProvider
        .getState()
        .selectModelProvider(provider.provider, model.id)
      void switchToModel({
        modelId: model.id,
        providerName: provider.provider,
        serviceHub,
      }).catch((error) => {
        startingIdRef.current = null
        console.error('[DeferredFirstSend] failed to start model', error)
      })
      return
    }
  }, [providers, queued, serviceHub, worker])

  // Once the selected local model is actually serving, create the chat and
  // hand it to the background session. Route movement is decided at this
  // moment: New Chat follows the new conversation; every other page stays put.
  useEffect(() => {
    if (!queued || worker || !selectedModel?.id) return
    // New Chat is still mounted and sends this one itself.
    if (claimedId === queued.id) return
    if (!activeModels.includes(selectedModel.id)) return
    if (
      !queued.downloadModelIds.some((id) =>
        matchesModelId(selectedModel.id, id)
      )
    ) {
      return
    }

    let cancelled = false
    const createBackgroundThread = async () => {
      const assistantState = useAssistant.getState()
      const assistant =
        assistantState.pendingAssistant ??
        assistantState.assistants.find(
          (item) => item.id === assistantState.defaultAssistantId
        ) ??
        assistantState.assistants[0]
      const previousThreadId = useThreads.getState().currentThreadId
      const navigateWhenStarted = window.location.pathname === route.home
      const thread = await useThreads.getState().createThread(
        { id: selectedModel.id, provider: selectedProvider },
        queued.prompt,
        assistant
      )
      if (cancelled) return
      if (!navigateWhenStarted) {
        useThreads.setState({ currentThreadId: previousThreadId })
      }
      // Before the send: its tool calls are approved by this thread's mode.
      if (queued.agentState) {
        useAgentMode
          .getState()
          .handOffThreadState(HOME_COMPOSER_KEY, thread.id, queued.agentState)
      }
      setWorker({
        queueId: queued.id,
        threadId: thread.id,
        title: thread.title ?? queued.prompt,
        prompt: queued.prompt,
        navigateWhenStarted,
        systemMessage: assistant?.instructions,
      })
      clearQueue(queued.id)
      startingIdRef.current = null
    }
    void createBackgroundThread().catch((error) => {
      startingIdRef.current = null
      console.error('[DeferredFirstSend] failed to create thread', error)
      toast.error(t('chat:replyGate.backgroundFailed'))
    })
    return () => {
      cancelled = true
    }
  }, [
    activeModels,
    claimedId,
    clearQueue,
    queued,
    selectedModel,
    selectedProvider,
    t,
    worker,
  ])

  useEffect(() => {
    if (!worker || sentThreadRef.current === worker.threadId) return
    sentThreadRef.current = worker.threadId

    const messageId = generateId()
    const userMessage = newUserThreadContent(
      worker.threadId,
      worker.prompt,
      [],
      messageId,
      resolveAssistantForThread(worker.threadId)
    )
    const turnIndex = useMessages.getState().getMessages(worker.threadId).length
    useMessages.getState().addMessage(userMessage)
    ttftBegin()
    turnErrorRef.current = undefined
    sendMessage({
      id: messageId,
      parts: [
        { type: 'text', text: userMessage.content[0].text?.value ?? worker.prompt },
      ],
      metadata: userMessage.metadata,
    })

    // The same `chat_request_sent` the thread page sends for a chat turn. This
    // send is always the chat transport, whatever Agent mode says; the route's
    // reason is reported only when the router would have picked it too.
    const routed = resolveThreadExecutionRoute(worker.threadId)
    const routeReason =
      routed.route === 'chat-transport' ? routed.reason : undefined
    const turnId = beginChatTurn(worker.threadId)
    sentTurnRef.current = { threadId: worker.threadId, turnId, routeReason }
    const { selectedModel: model, selectedProvider: provider } =
      useModelProvider.getState()
    const { ragToolNames, mcpToolNames, toolCostReports } =
      useAppState.getState()
    const toolCost = toolCostReports[worker.threadId]
    captureChatRequest({
      ...attachmentTelemetry([]),
      engine: 'chat-transport',
      route_reason: routeReason,
      ...contextTelemetry(null, selectedCtxLen()),
      turn_id: turnId,
      thread_id: worker.threadId,
      source: 'chat',
      model_id: model?.id,
      provider,
      turn_index: turnIndex,
      prompt_len_bucket: lengthBucket(worker.prompt.length),
      is_agent_mode: false,
      agent_skill: null,
      tools_enabled_count: ragToolNames.size + mcpToolNames.size,
      has_rag: ragToolNames.size > 0,
      has_mcp: mcpToolNames.size > 0,
      tools_tokens_estimate: toolCost?.totalTokens ?? null,
      tools_ctx_share:
        toolCost?.ctxShare !== undefined
          ? Math.round(toolCost.ctxShare * 100) / 100
          : null,
      tools_heavy_servers: toolCost?.heavyServers.length ?? 0,
    })

    // The queued text is the home composer's draft. Clear it there, not in
    // whichever chat the user has opened since.
    const prompts = usePrompt.getState()
    if (prompts.getDraft(HOME_COMPOSER_KEY) === worker.prompt) {
      prompts.setDraft(HOME_COMPOSER_KEY, '')
    }
    useAssistant.getState().setPendingAssistant(undefined)

    if (worker.navigateWhenStarted) {
      void navigate({
        to: route.threadsDetail,
        params: { threadId: worker.threadId },
      })
    } else {
      toast.success(t('chat:replyGate.backgroundStarted'))
    }
  }, [navigate, sendMessage, t, worker])

  return null
}
