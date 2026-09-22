import type { ModelLoadProgress } from '@/lib/inference-status'
import type { ToolCostReport } from '@/lib/tool-cost'
import { create } from 'zustand'
import { ThreadMessage } from '@janhq/core'
import { MCPTool } from '@/types/completion'

export type PromptProgress = {
  cache: number
  processed: number
  time_ms: number
  total: number
}

type AppErrorMessage = {
  message?: string
  title?: string
  subtitle: string
}

type AppState = {
  streamingContent?: ThreadMessage
  // Last measured cost of the tool definitions per thread ('' = index page).
  toolCostReports: Record<string, ToolCostReport>
  setToolCostReport: (threadId: string, report: ToolCostReport) => void
  loadingModel?: boolean
  /**
   * The model the load in flight is for, and whether it is a cold start or a
   * swap of an engine that was already serving (switching backend, or picking
   * a different local model). Both are cleared with `loadingModel`; they exist
   * so the status surface can say which of the two is happening rather than
   * showing one undifferentiated spinner. See `deriveInferenceStatus`.
   */
  loadingModelId?: string
  loadingModelKind?: 'start' | 'restart'
  /**
   * The step the load in flight is on (ATO-530), and whether the user has
   * asked for it to stop. Reset with every `updateLoadingModel`.
   */
  loadingModelProgress?: ModelLoadProgress
  loadingModelCancelling?: boolean
  tools: MCPTool[]
  ragToolNames: Set<string>
  mcpToolNames: Set<string>
  serverStatus: 'running' | 'stopped' | 'pending'
  abortControllers: Record<string, AbortController>
  tokenSpeed?: TokenSpeed
  errorMessage?: AppErrorMessage
  promptProgress?: PromptProgress
  activeModels: string[]
  /**
   * Local models the user stopped by hand, as {@link modelStopKey} keys. The
   * composer's auto-start leaves these alone until the user asks for the model
   * again — by sending, or by picking it — so a Stop is not undone the moment
   * a chat is back on screen.
   */
  userStoppedModels: string[]
  cancelToolCall?: () => void
  setServerStatus: (value: 'running' | 'stopped' | 'pending') => void
  updateStreamingContent: (content: ThreadMessage | undefined) => void
  updateLoadingModel: (
    loading: boolean,
    load?: { modelId?: string; kind?: 'start' | 'restart' }
  ) => void
  setLoadingModelProgress: (progress: ModelLoadProgress) => void
  setLoadingModelCancelling: (cancelling: boolean) => void
  updateTools: (tools: MCPTool[]) => void
  updateRagToolNames: (names: string[]) => void
  updateMcpToolNames: (names: string[]) => void
  setAbortController: (threadId: string, controller: AbortController) => void
  updateTokenSpeed: (message: ThreadMessage, increment?: number) => void
  setTokenSpeed: (
    message: ThreadMessage,
    speed: number,
    completionTokens: number
  ) => void
  resetTokenSpeed: () => void
  clearAppState: () => void
  setCancelToolCall: (cancel: (() => void) | undefined) => void
  setErrorMessage: (error: AppErrorMessage | undefined) => void
  updatePromptProgress: (progress: PromptProgress | undefined) => void
  setActiveModels: (models: string[]) => void
  setUserStoppedModels: (keys: string[]) => void
}

/** Identity of a model on one engine, as `userStoppedModels` records it. */
export function modelStopKey(providerName: string, modelId: string): string {
  return `${providerName}::${modelId}`
}

export const useAppState = create<AppState>()((set) => ({
  streamingContent: undefined,
  toolCostReports: {},
  setToolCostReport: (threadId, report) =>
    set((state) => ({
      toolCostReports: { ...state.toolCostReports, [threadId]: report },
    })),
  loadingModel: false,
  loadingModelId: undefined,
  loadingModelKind: undefined,
  loadingModelProgress: undefined,
  loadingModelCancelling: false,
  tools: [],
  ragToolNames: new Set<string>(),
  mcpToolNames: new Set<string>(),
  serverStatus: 'stopped',
  abortControllers: {},
  tokenSpeed: undefined,
  currentToolCall: undefined,
  promptProgress: undefined,
  cancelToolCall: undefined,
  activeModels: [],
  userStoppedModels: [],
  updateStreamingContent: (content: ThreadMessage | undefined) => {
    set(() => ({
      streamingContent: content
        ? {
            ...content,
            created_at: content.created_at || Date.now(),
          }
        : undefined,
    }))
  },
  updateLoadingModel: (loading, load) => {
    set({
      loadingModel: loading,
      loadingModelId: loading ? load?.modelId : undefined,
      loadingModelKind: loading ? load?.kind : undefined,
      loadingModelProgress: loading ? { kind: 'preparing' } : undefined,
      loadingModelCancelling: false,
    })
  },
  setLoadingModelProgress: (progress) =>
    set((state) =>
      state.loadingModel ? { loadingModelProgress: progress } : {}
    ),
  setLoadingModelCancelling: (cancelling) =>
    set({ loadingModelCancelling: cancelling }),
  updateTools: (tools) => {
    set({ tools })
  },
  updateRagToolNames: (names) => {
    set({ ragToolNames: new Set(names) })
  },
  updateMcpToolNames: (names) => {
    set({ mcpToolNames: new Set(names) })
  },
  setServerStatus: (value) => set({ serverStatus: value }),
  setAbortController: (threadId, controller) => {
    set((state) => ({
      abortControllers: {
        ...state.abortControllers,
        [threadId]: controller,
      },
    }))
  },
  setTokenSpeed: (message, speed, completionTokens) => {
    set((state) => ({
      tokenSpeed: {
        ...state.tokenSpeed,
        lastTimestamp: new Date().getTime(),
        tokenSpeed: speed,
        tokenCount: completionTokens,
        message: message.id,
      },
    }))
  },
  updateTokenSpeed: (message, increment = 1) =>
    set((state) => {
      const currentTimestamp = new Date().getTime() // Get current time in milliseconds
      if (!state.tokenSpeed) {
        // If this is the first update, just set the lastTimestamp and return
        return {
          tokenSpeed: {
            lastTimestamp: currentTimestamp,
            tokenSpeed: 0,
            tokenCount: increment,
            message: message.id,
          },
        }
      }

      const timeDiffInSeconds =
        (currentTimestamp - state.tokenSpeed.lastTimestamp) / 1000 // Time difference in seconds
      const totalTokenCount = state.tokenSpeed.tokenCount + increment
      const averageTokenSpeed =
        totalTokenCount / (timeDiffInSeconds > 0 ? timeDiffInSeconds : 1) // Calculate average token speed
      return {
        tokenSpeed: {
          ...state.tokenSpeed,
          tokenSpeed: averageTokenSpeed,
          tokenCount: totalTokenCount,
          message: message.id,
        },
      }
    }),
  resetTokenSpeed: () =>
    set({
      tokenSpeed: undefined,
    }),
  clearAppState: () =>
    set({
      streamingContent: undefined,
      abortControllers: {},
      tokenSpeed: undefined,
      cancelToolCall: undefined,
      errorMessage: undefined,
    }),
  setCancelToolCall: (cancel) => {
    set(() => ({
      cancelToolCall: cancel,
    }))
  },
  setErrorMessage: (error) => {
    set(() => ({
      errorMessage: error,
    }))
  },
  updatePromptProgress: (progress) => {
    set(() => ({
      promptProgress: progress,
    }))
  },
  setActiveModels: (models: string[]) => {
    set(() => ({
      activeModels: models,
    }))
  },
  setUserStoppedModels: (keys: string[]) => {
    set(() => ({
      userStoppedModels: keys,
    }))
  },
}))
