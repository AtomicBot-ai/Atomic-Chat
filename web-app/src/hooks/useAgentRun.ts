import { create } from 'zustand'
import type {
  AgentEvent,
  AgentRunState,
  AgentRunToolTrace,
} from '@/types/agent'

export function createAgentRunState(): AgentRunState {
  return {
    status: 'idle',
    approvalResolving: false,
    folderAccessResolving: false,
    trace: {
      reasoning: {},
      assistantText: '',
      tools: [],
      loops: [],
    },
  }
}

function replaceParsedTool(
  tools: AgentRunToolTrace[],
  event: Extract<AgentEvent, { type: 'tool_call_executed' }>
): AgentRunToolTrace[] {
  const index = (() => {
    for (let candidate = tools.length - 1; candidate >= 0; candidate -= 1) {
      const item = tools[candidate]
      if (
        item.outcome === undefined &&
        item.batchIndex === event.result.batch_index &&
        item.batchSize === event.result.batch_size &&
        item.call.tool === event.result.call.tool
      ) {
        return candidate
      }
    }
    return -1
  })()
  const executed: AgentRunToolTrace = {
    call: event.result.call,
    outcome: event.result.outcome,
    batchIndex: event.result.batch_index,
    batchSize: event.result.batch_size,
  }
  if (index < 0) {
    return [...tools, executed]
  }
  return tools.map((item, itemIndex) => (itemIndex === index ? executed : item))
}

export function reduceAgentRunState(
  state: AgentRunState,
  event: AgentEvent,
  nowMs: number = Date.now()
): AgentRunState {
  switch (event.type) {
    case 'turn_started':
      return {
        ...createAgentRunState(),
        runId: event.run_id,
        startedAtMs: state.startedAtMs ?? nowMs,
        status: 'running',
      }
    case 'step_started':
      return {
        ...state,
        status: 'running',
      }
    case 'reasoning_delta':
      return {
        ...state,
        trace: {
          ...state.trace,
          reasoning: {
            ...state.trace.reasoning,
            [event.step_index]:
              (state.trace.reasoning[event.step_index] ?? '') + event.text,
          },
        },
      }
    case 'assistant_delta':
      return {
        ...state,
        trace: {
          ...state.trace,
          assistantText: state.trace.assistantText + event.text,
        },
      }
    case 'tool_call_parsed':
      return {
        ...state,
        trace: {
          ...state.trace,
          tools: [
            ...state.trace.tools,
            {
              call: event.call,
              batchIndex: event.batch_index,
              batchSize: event.batch_size,
            },
          ],
        },
      }
    case 'tool_call_executed':
      return {
        ...state,
        status: 'running',
        pendingApproval: undefined,
        pendingFolderAccess: undefined,
        approvalResolving: false,
        folderAccessResolving: false,
        trace: {
          ...state.trace,
          tools: replaceParsedTool(state.trace.tools, event),
        },
      }
    case 'approval_requested':
      return {
        ...state,
        status: 'awaiting_approval',
        pendingApproval: event,
        approvalResolving: false,
      }
    case 'folder_access_requested':
      return {
        ...state,
        status: 'awaiting_folder_access',
        pendingFolderAccess: event,
        folderAccessResolving: false,
      }
    case 'loop_detected':
      return {
        ...state,
        trace: {
          ...state.trace,
          loops: [
            ...state.trace.loops,
            {
              level: event.level,
              detector: event.detector,
              message: event.message,
            },
          ],
        },
      }
    case 'parse_retry':
    case 'batch_trimmed':
      return state
    case 'assistant_reply':
      return {
        ...state,
        trace: {
          ...state.trace,
          assistantText: event.text,
        },
      }
    case 'step_error':
      return {
        ...state,
        status: 'failed',
        pendingApproval: undefined,
        pendingFolderAccess: undefined,
        approvalResolving: false,
        folderAccessResolving: false,
        trace: {
          ...state.trace,
          error: {
            category: event.category,
            message: event.message,
          },
        },
      }
    case 'turn_finished': {
      const status =
        event.reason === 'cancelled'
          ? 'cancelled'
          : event.reason === 'failed'
            ? 'failed'
            : 'finished'
      return {
        ...state,
        finishedAtMs: nowMs,
        status,
        pendingApproval: undefined,
        pendingFolderAccess: undefined,
        approvalResolving: false,
        folderAccessResolving: false,
        trace: {
          ...state.trace,
          finishReason: event.reason,
          stepCount: event.step_count,
        },
      }
    }
  }
}

type AgentRunStore = {
  runs: Record<string, AgentRunState>
  getRun: (threadId: string) => AgentRunState
  startRun: (threadId: string, runId: string) => void
  applyEvent: (threadId: string, event: AgentEvent) => void
  setApprovalResolving: (threadId: string, resolving: boolean) => void
  setFolderAccessResolving: (threadId: string, resolving: boolean) => void
  clearPendingApproval: (threadId: string, approvalId: string) => void
  clearPendingFolderAccess: (threadId: string, accessId: string) => void
  clearRun: (threadId: string) => void
  clearAll: () => void
}

export const useAgentRun = create<AgentRunStore>()((set, get) => ({
  runs: {},
  getRun: (threadId) => get().runs[threadId] ?? createAgentRunState(),
  startRun: (threadId, runId) => {
    set((state) => ({
      runs: {
        ...state.runs,
        [threadId]: {
          ...createAgentRunState(),
          runId,
          startedAtMs: Date.now(),
          status: 'running',
        },
      },
    }))
  },
  applyEvent: (threadId, event) => {
    set((state) => ({
      runs: {
        ...state.runs,
        [threadId]: reduceAgentRunState(
          state.runs[threadId] ?? createAgentRunState(),
          event
        ),
      },
    }))
  },
  setApprovalResolving: (threadId, resolving) => {
    set((state) => {
      const run = state.runs[threadId]
      if (!run) return state
      return {
        runs: {
          ...state.runs,
          [threadId]: {
            ...run,
            approvalResolving: resolving,
          },
        },
      }
    })
  },
  setFolderAccessResolving: (threadId, resolving) => {
    set((state) => {
      const run = state.runs[threadId]
      if (!run) return state
      return {
        runs: {
          ...state.runs,
          [threadId]: {
            ...run,
            folderAccessResolving: resolving,
          },
        },
      }
    })
  },
  clearPendingApproval: (threadId, approvalId) => {
    set((state) => {
      const run = state.runs[threadId]
      if (!run || run.pendingApproval?.approval_id !== approvalId) return state
      return {
        runs: {
          ...state.runs,
          [threadId]: {
            ...run,
            status: run.status === 'awaiting_approval' ? 'running' : run.status,
            pendingApproval: undefined,
            approvalResolving: false,
          },
        },
      }
    })
  },
  clearPendingFolderAccess: (threadId, accessId) => {
    set((state) => {
      const run = state.runs[threadId]
      if (!run || run.pendingFolderAccess?.access_id !== accessId) return state
      return {
        runs: {
          ...state.runs,
          [threadId]: {
            ...run,
            status:
              run.status === 'awaiting_folder_access' ? 'running' : run.status,
            pendingFolderAccess: undefined,
            folderAccessResolving: false,
          },
        },
      }
    })
  },
  clearRun: (threadId) => {
    set((state) => {
      const runs = { ...state.runs }
      delete runs[threadId]
      return { runs }
    })
  },
  clearAll: () => set({ runs: {} }),
}))
