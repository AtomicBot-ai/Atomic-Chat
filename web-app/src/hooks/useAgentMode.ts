import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type AgentApprovalMode = 'manual' | 'skip'

type AgentModeState = {
  /** Map of threadId → agent mode enabled */
  agentThreads: Record<string, boolean>
  approvalModes: Record<string, AgentApprovalMode>
  workingDirs: Record<string, string>

  isAgentMode: (threadId: string) => boolean
  getApprovalMode: (threadId: string) => AgentApprovalMode
  getWorkingDir: (threadId: string) => string | undefined
  toggleAgentMode: (threadId: string) => void
  setAgentMode: (threadId: string, enabled: boolean) => void
  setApprovalMode: (threadId: string, mode: AgentApprovalMode) => void
  setWorkingDir: (threadId: string, workingDir: string) => void
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
      workingDirs: {},

      isAgentMode: (threadId) => {
        return get().agentThreads[threadId] === true
      },

      getApprovalMode: (threadId) => {
        return get().approvalModes[threadId] ?? 'manual'
      },

      getWorkingDir: (threadId) => {
        return get().workingDirs[threadId]
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

      setWorkingDir: (threadId, workingDir) => {
        set((state) => ({
          workingDirs: {
            ...state.workingDirs,
            [threadId]: workingDir,
          },
        }))
      },

      transferAgentMode: (fromThreadId, toThreadId) => {
        set((state) => {
          const isAgentMode = state.agentThreads[fromThreadId] === true
          const approvalMode = state.approvalModes[fromThreadId] ?? 'manual'
          const workingDir = state.workingDirs[fromThreadId]
          const remainingThreads = { ...state.agentThreads }
          const remainingApprovalModes = { ...state.approvalModes }
          const remainingWorkingDirs = { ...state.workingDirs }
          delete remainingThreads[fromThreadId]
          delete remainingThreads[toThreadId]
          delete remainingApprovalModes[fromThreadId]
          delete remainingApprovalModes[toThreadId]
          delete remainingWorkingDirs[fromThreadId]
          delete remainingWorkingDirs[toThreadId]

          return {
            agentThreads: isAgentMode
              ? { ...remainingThreads, [toThreadId]: true }
              : remainingThreads,
            approvalModes: isAgentMode
              ? { ...remainingApprovalModes, [toThreadId]: approvalMode }
              : remainingApprovalModes,
            workingDirs:
              isAgentMode && workingDir
                ? { ...remainingWorkingDirs, [toThreadId]: workingDir }
                : remainingWorkingDirs,
          }
        })
      },

      removeThread: (threadId) => {
        set((state) => {
          const agentThreads = { ...state.agentThreads }
          const approvalModes = { ...state.approvalModes }
          const workingDirs = { ...state.workingDirs }
          delete agentThreads[threadId]
          delete approvalModes[threadId]
          delete workingDirs[threadId]
          return { agentThreads, approvalModes, workingDirs }
        })
      },

      clearAll: () => {
        set({ agentThreads: {}, approvalModes: {}, workingDirs: {} })
      },
    }),
    {
      name: localStorageKey.agentMode,
      storage: createJSONStorage(() => localStorage),
    }
  )
)
