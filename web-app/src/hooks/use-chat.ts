import { CustomChatTransport } from '@/lib/custom-chat-transport'
// import { useCapabilities } from "@/stores/capabilities-store";
import {
  Chat,
  type UIMessage,
  type UseChatOptions,
  useChat as useChatSDK,
} from '@ai-sdk/react'
import { type ChatInit, type LanguageModelUsage } from 'ai'
import { useEffect, useMemo, useRef, useCallback } from 'react'
import { listen } from '@tauri-apps/api/event'
import { ttftMarkFromRust } from '@/lib/ttft-timing'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { useChatSessions } from '@/stores/chat-session-store'
import { useAppState } from '@/hooks/useAppState'
import { useToolAvailable } from '@/hooks/useToolAvailable'

/** What a Chat calls back into the page that drives it. */
type ChatCallbacks = Pick<
  ChatInit<UIMessage>,
  'onError' | 'onToolCall' | 'onFinish' | 'onData' | 'sendAutomaticallyWhen'
>

/**
 * Per session, the callbacks of the hook's latest render. A session's Chat is
 * created once and handed to every later mount by `ensureSession`, and the AI
 * SDK never updates a Chat's callbacks: made with the first mount's closures,
 * its `onFinish` set state on a thread page that had since unmounted (the user
 * went to Settings, the Hub or a new chat and back). The reply finished,
 * Working stayed and Enter did nothing until Stop (ATO-538). The Chat calls
 * through these instead.
 */
const latestCallbacks = new Map<string, { current: ChatCallbacks }>()

function callbacksOf(sessionId: string): { current: ChatCallbacks } {
  let holder = latestCallbacks.get(sessionId)
  if (!holder) {
    holder = { current: {} }
    latestCallbacks.set(sessionId, holder)
  }
  return holder
}

/** Callbacks that look up the latest ones on every call. */
function forwardTo(holder: { current: ChatCallbacks }): ChatCallbacks {
  return {
    onError: (error) => holder.current.onError?.(error),
    onToolCall: (options) => holder.current.onToolCall?.(options),
    onFinish: (options) => holder.current.onFinish?.(options),
    onData: (part) => holder.current.onData?.(part),
    sendAutomaticallyWhen: (options) =>
      holder.current.sendAutomaticallyWhen?.(options) ?? false,
  }
}

type CustomChatOptions = Omit<ChatInit<UIMessage>, 'transport'> &
  Pick<UseChatOptions<UIMessage>, 'experimental_throttle' | 'resume'> & {
    sessionId?: string
    sessionTitle?: string
    systemMessage?: string
    onTokenUsage?: (usage: LanguageModelUsage, messageId: string) => void
  }

// This is a wrapper around the AI SDK's useChat hook
// It implements model switching and uses the custom chat transport,
// making a nice reusable hook for chat functionality.
export function useChat(options?: CustomChatOptions) {
  const transportRef = useRef<CustomChatTransport | undefined>(undefined) // Using a ref here so we can update the model used in the transport without having to reload the page or recreate the transport
  const {
    sessionId,
    sessionTitle,
    systemMessage,
    onTokenUsage,
    ...chatInitOptions
  } = options ?? {}
  const ensureSession = useChatSessions((state) => state.ensureSession)
  const setSessionTitle = useChatSessions((state) => state.setSessionTitle)
  const updateStatus = useChatSessions((state) => state.updateStatus)

  // Get serviceHub and model metadata from app state
  const mcpToolNames = useAppState((state) => state.mcpToolNames)
  const ragToolNames = useAppState((state) => state.ragToolNames)
  // Connectors muted for this chat change the tool set without any MCP
  // event, so they are a refresh trigger of their own.
  const mutedServersKey = useToolAvailable((state) =>
    (sessionId
      ? (state.mutedServers[sessionId] ?? state.defaultMutedServers)
      : state.defaultMutedServers
    ).join(',')
  )
  // Same for single tools switched off in the connector's tools dialog: the
  // cost badge in the plugins menu is measured on what refreshTools builds.
  const disabledToolsKey = useToolAvailable((state) =>
    (sessionId
      ? (state.disabledTools[sessionId] ?? state.defaultDisabledTools)
      : state.defaultDisabledTools
    ).join(',')
  )

  const existingSessionTransport = sessionId
    ? useChatSessions.getState().sessions[sessionId]?.transport
    : undefined

  // Bind the transport to the *current* session. This route component does
  // not unmount when navigating between threads (only the param changes), so
  // transportRef survives. If we kept the previous thread's transport for a
  // freshly-opened thread, RAG/project lookups (keyed on transport.threadId)
  // would run against the previous thread's project — leaking its files into
  // unrelated chats. So: prefer the session-scoped transport, otherwise create
  // a fresh one whenever the cached transport belongs to a different thread.
  if (existingSessionTransport) {
    transportRef.current = existingSessionTransport
  } else if (
    !transportRef.current ||
    transportRef.current.getThreadId() !== sessionId
  ) {
    transportRef.current = new CustomChatTransport(systemMessage, sessionId)
  }

  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.updateSystemMessage(systemMessage)
    }
  }, [systemMessage])

  // Set up streaming token speed callback to update global state
  const resetTokenSpeed = useAppState((state) => state.resetTokenSpeed)

  // Update the token usage callback when it changes
  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.setOnTokenUsage(onTokenUsage)
    }
  }, [onTokenUsage])

  if (sessionId) {
    const { onError, onToolCall, onFinish, onData, sendAutomaticallyWhen } =
      chatInitOptions
    callbacksOf(sessionId).current = {
      onError,
      onToolCall,
      onFinish,
      onData,
      sendAutomaticallyWhen,
    }
  }

  // Memoize to prevent calling ensureSession (which has side effects) on every render
  const chat = useMemo(() => {
    if (!sessionId || !transportRef.current) return undefined

    return ensureSession(
      sessionId,
      transportRef.current,
      () =>
        new Chat({
          ...chatInitOptions,
          ...forwardTo(callbacksOf(sessionId)),
          transport: transportRef.current,
        }),
      sessionTitle
    )
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [sessionId, ensureSession])

  useEffect(() => {
    if (sessionId && sessionTitle) {
      setSessionTitle(sessionId, sessionTitle)
    }
  }, [sessionId, sessionTitle, setSessionTitle])

  const chatResult = useChatSDK({
    ...(chat
      ? { chat }
      : { transport: transportRef.current, ...chatInitOptions }),
    experimental_throttle: options?.experimental_throttle,
    resume: false,
  })

  useEffect(() => {
    if (sessionId) {
      updateStatus(sessionId, chatResult.status)
    }
  }, [sessionId, chatResult.status, updateStatus])

  // Reset token speed when streaming stops
  useEffect(() => {
    if (chatResult.status !== 'streaming') {
      resetTokenSpeed()
    }
  }, [chatResult.status, resetTokenSpeed])

  // Refresh tools when MCP or RAG tool names change (e.g., when MCP servers start/stop)
  useEffect(() => {
    if (transportRef.current) {
      transportRef.current.invalidateToolsCache()
      void transportRef.current.refreshTools(true)
    }
  }, [mcpToolNames, ragToolNames, mutedServersKey, disabledToolsKey])

  // The Rust proxy emits these unconditionally; collecting them is what makes
  // the proxy/backend split of TTFT visible in `chat_response_received`.
  useEffect(() => {
    let cancelled = false
    let detach: (() => Promise<void>) | null = null

    const setup = async () => {
      try {
        const unlisten = await listen<{ marker: string; ms: number }>(
          'ttft-timing',
          (event) => {
            const marker = event.payload.marker
            if (
              marker === 'zetaProxyIn' ||
              marker === 'zetaUpstreamHeaders' ||
              marker === 'etaFirstToken'
            ) {
              ttftMarkFromRust(marker, event.payload.ms)
            }
          }
        )
        detach = createSafeUnlisten(unlisten)
        if (cancelled) await detach()
      } catch (e) {
        console.error('Failed to attach ttft-timing listener', e)
      }
    }

    void setup()

    return () => {
      cancelled = true
      void detach?.()
    }
  }, [])

  const setContinueFromContent = useCallback((content: string) => {
    transportRef.current?.setContinueFromContent(content)
  }, [])

  // Expose method to update RAG tools availability
  const updateRagToolsAvailability = useCallback(
    async (
      hasDocuments: boolean,
      modelSupportsTools: boolean,
      ragFeatureAvailable: boolean
    ) => {
      if (transportRef.current) {
        await transportRef.current.updateRagToolsAvailability(
          hasDocuments,
          modelSupportsTools,
          ragFeatureAvailable
        )
      }
    },
    []
  )

  return {
    ...chatResult,
    updateRagToolsAvailability,
    setContinueFromContent,
  }
}
