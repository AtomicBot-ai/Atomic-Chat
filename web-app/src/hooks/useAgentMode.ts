import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type AgentApprovalMode = 'manual' | 'skip'

type AgentModeState = {
  /** Map of threadId → agent mode enabled */
  agentThreads: Record<string, boolean>
  approvalModes: Record<string, AgentApprovalMode>

  isAgentMode: (threadId: string) => boolean
  getApprovalMode: (threadId: string) => AgentApprovalMode
  toggleAgentMode: (threadId: string) => void
  setAgentMode: (threadId: string, enabled: boolean) => void
  setApprovalMode: (threadId: string, mode: AgentApprovalMode) => void
  transferAgentMode: (fromThreadId: string, toThreadId: string) => void
  removeThread: (threadId: string) => void
  /** Clear agent mode for all threads. */
  clearAll: () => void
}

export const useAgentMode = create<AgentModeState>()(
  persist(
    (set, get) => ({
      agentThreads: {},
      approvalModes: {},

      isAgentMode: (threadId) => {
        return get().agentThreads[threadId] === true
      },

      getApprovalMode: (threadId) => {
        return get().approvalModes[threadId] ?? 'manual'
      },

      toggleAgentMode: (threadId) => {
        set((state) => ({
          agentThreads: {
            ...state.agentThreads,
            [threadId]: !state.agentThreads[threadId],
          },
        }))
      },

      setAgentMode: (threadId, enabled) => {
        set((state) => ({
          agentThreads: {
            ...state.agentThreads,
            [threadId]: enabled,
          },
        }))
      },

      setApprovalMode: (threadId, mode) => {
        set((state) => ({
          approvalModes: {
            ...state.approvalModes,
            [threadId]: mode,
          },
        }))
      },

      transferAgentMode: (fromThreadId, toThreadId) => {
        set((state) => {
          const isAgentMode = state.agentThreads[fromThreadId] === true
          const approvalMode = state.approvalModes[fromThreadId] ?? 'manual'
          const remainingThreads = { ...state.agentThreads }
          const remainingApprovalModes = { ...state.approvalModes }
          delete remainingThreads[fromThreadId]
          delete remainingThreads[toThreadId]
          delete remainingApprovalModes[fromThreadId]
          delete remainingApprovalModes[toThreadId]

          return {
            agentThreads: isAgentMode
              ? { ...remainingThreads, [toThreadId]: true }
              : remainingThreads,
            approvalModes: isAgentMode
              ? { ...remainingApprovalModes, [toThreadId]: approvalMode }
              : remainingApprovalModes,
          }
        })
      },

      removeThread: (threadId) => {
        set((state) => {
          const agentThreads = { ...state.agentThreads }
          const approvalModes = { ...state.approvalModes }
          delete agentThreads[threadId]
          delete approvalModes[threadId]
          return { agentThreads, approvalModes }
        })
      },

      clearAll: () => {
        set({ agentThreads: {}, approvalModes: {} })
      },
    }),
    {
      name: localStorageKey.agentMode,
      storage: createJSONStorage(() => localStorage),
    }
  )
)
