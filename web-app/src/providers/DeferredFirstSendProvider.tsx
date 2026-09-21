import { useEffect, useRef, useState } from 'react'
import { generateId } from 'ai'
import {
  ChatCompletionRole,
  MessageStatus,
  type ThreadMessage,
} from '@janhq/core'
import { useNavigate } from '@tanstack/react-router'
import { toast } from 'sonner'

import { route } from '@/constants/routes'
import { useAppState } from '@/hooks/useAppState'
import { useAssistant } from '@/hooks/useAssistant'
import { useChat } from '@/hooks/use-chat'
import { useMessages } from '@/hooks/useMessages'
import { useModelProvider } from '@/hooks/useModelProvider'
import { usePrompt } from '@/hooks/usePrompt'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useToolApproval } from '@/hooks/useToolApproval'
import { newUserThreadContent } from '@/lib/completion'
import {
  executeChatToolCalls,
  shouldSendToolFollowUp,
  type ChatToolCall,
  type ChatToolOutput,
} from '@/lib/execute-chat-tool-calls'
import { renderInstructions } from '@/lib/instructionTemplate'
import { extractContentPartsFromUIMessage } from '@/lib/messages'
import { downscaleToolResultContent } from '@/lib/toolResultImages'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { resolveMcpAutoApprove } from '@/lib/mcp-approval'
import { useDeferredFirstSend } from '@/stores/deferred-first-send-store'
import { useDownloadStore } from '@/hooks/useDownloadStore'
import { switchToModel } from '@/utils/switchModel'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Worker = {
  queueId: string
  threadId: string
  title: string
  prompt: string
  navigateWhenStarted: boolean
  systemMessage?: string
}

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
      console.error('[DeferredFirstSend] background send failed', error)
      toast.error(t('chat:replyGate.backgroundFailed'))
    },
    onFinish: ({ message, isAbort }) => {
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
        approve: (toolName, threadId, input) =>
          resolveMcpAutoApprove(threadId)
            ? Promise.resolve(true)
            : useToolApproval
                .getState()
                .showApprovalModal(toolName, threadId, input, {
                  bypassGlobalAutoApprove: true,
                }),
        callRagTool: (args) => serviceHub.rag().callTool(args),
        callMcpTool: (args) => serviceHub.mcp().callTool(args),
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
      setWorker({
        queueId: queued.id,
        threadId: thread.id,
        title: thread.title ?? queued.prompt,
        prompt: queued.prompt,
        navigateWhenStarted,
        systemMessage: assistant?.instructions
          ? renderInstructions(assistant.instructions)
          : undefined,
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
      messageId
    )
    useMessages.getState().addMessage(userMessage)
    sendMessage({
      id: messageId,
      parts: [{ type: 'text', text: worker.prompt }],
      metadata: userMessage.metadata,
    })

    if (usePrompt.getState().prompt === worker.prompt) {
      usePrompt.getState().setPrompt('')
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
