import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type AgentApprovalMode = 'manual' | 'skip'
export type SidebarMode = 'chat' | 'agent'
export type AgentWorkspaceRoot = {
  rootId: string
  path: string
  name: string
  canEdit: boolean
}
export type AgentWorkspace = {
  primaryRoot?: AgentWorkspaceRoot
  externalRoots: AgentWorkspaceRoot[]
}

type AgentModeState = {
  /** Map of threadId → agent mode enabled */
  agentThreads: Record<string, boolean>
  approvalModes: Record<string, AgentApprovalMode>
  workspaces: Record<string, AgentWorkspace>
  sidebarMode: SidebarMode

  isAgentMode: (threadId: string) => boolean
  getApprovalMode: (threadId: string) => AgentApprovalMode
  getWorkingDir: (threadId: string) => string | undefined
  getWorkspace: (threadId: string) => AgentWorkspace
  setPrimaryRoot: (threadId: string, root: AgentWorkspaceRoot) => void
  addExternalRoot: (threadId: string, root: AgentWorkspaceRoot) => void
  setExternalRootPermission: (
    threadId: string,
    rootId: string,
    canEdit: boolean
  ) => void
  removeExternalRoot: (threadId: string, rootId: string) => void
  setSidebarMode: (mode: SidebarMode) => void
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
      workspaces: {},
      sidebarMode: 'chat',

      isAgentMode: (threadId) => {
        return get().agentThreads[threadId] === true
      },

      getApprovalMode: (threadId) => {
        return get().approvalModes[threadId] ?? 'manual'
      },

      getWorkingDir: (threadId) => {
        return get().workspaces[threadId]?.primaryRoot?.path
      },

      getWorkspace: (threadId) => {
        return get().workspaces[threadId] ?? { externalRoots: [] }
      },

      setPrimaryRoot: (threadId, root) => {
        set((state) => ({
          workspaces: {
            ...state.workspaces,
            [threadId]: {
              ...(state.workspaces[threadId] ?? { externalRoots: [] }),
              primaryRoot: root,
              externalRoots: (
                state.workspaces[threadId]?.externalRoots ?? []
              ).filter((item) => item.rootId !== root.rootId),
            },
          },
        }))
      },

      addExternalRoot: (threadId, root) => {
        set((state) => {
          const workspace = state.workspaces[threadId] ?? { externalRoots: [] }
          if (
            workspace.primaryRoot?.rootId === root.rootId ||
            workspace.externalRoots.some((item) => item.rootId === root.rootId)
          ) {
            return state
          }
          return {
            workspaces: {
              ...state.workspaces,
              [threadId]: {
                ...workspace,
                externalRoots: [...workspace.externalRoots, root],
              },
            },
          }
        })
      },

      setExternalRootPermission: (threadId, rootId, canEdit) => {
        set((state) => {
          const workspace = state.workspaces[threadId]
          if (!workspace) return state
          return {
            workspaces: {
              ...state.workspaces,
              [threadId]: {
                ...workspace,
                externalRoots: workspace.externalRoots.map((root) =>
                  root.rootId === rootId ? { ...root, canEdit } : root
                ),
              },
            },
          }
        })
      },

      removeExternalRoot: (threadId, rootId) => {
        set((state) => {
          const workspace = state.workspaces[threadId]
          if (!workspace) return state
          return {
            workspaces: {
              ...state.workspaces,
              [threadId]: {
                ...workspace,
                externalRoots: workspace.externalRoots.filter(
                  (root) => root.rootId !== rootId
                ),
              },
            },
          }
        })
      },

      setSidebarMode: (mode) => {
        // Opening a thread always re-asserts the mode. Without this guard every
        // navigation notifies the whole sidebar tree for an unchanged value.
        set((state) =>
          state.sidebarMode === mode ? state : { sidebarMode: mode }
        )
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
          workspaces: {
            ...state.workspaces,
            [threadId]: {
              ...(state.workspaces[threadId] ?? { externalRoots: [] }),
              primaryRoot: {
                rootId: `legacy:${workingDir}`,
                path: workingDir,
                name:
                  workingDir.split(/[\\/]/).filter(Boolean).at(-1) ??
                  workingDir,
                canEdit: true,
              },
            },
          },
        }))
      },

      transferAgentMode: (fromThreadId, toThreadId) => {
        set((state) => {
          const isAgentMode = state.agentThreads[fromThreadId] === true
          const approvalMode = state.approvalModes[fromThreadId] ?? 'manual'
          const workspace = state.workspaces[fromThreadId]
          const remainingThreads = { ...state.agentThreads }
          const remainingApprovalModes = { ...state.approvalModes }
          const remainingWorkspaces = { ...state.workspaces }
          delete remainingThreads[fromThreadId]
          delete remainingThreads[toThreadId]
          delete remainingApprovalModes[fromThreadId]
          delete remainingApprovalModes[toThreadId]
          delete remainingWorkspaces[fromThreadId]
          delete remainingWorkspaces[toThreadId]

          return {
            agentThreads: isAgentMode
              ? { ...remainingThreads, [toThreadId]: true }
              : remainingThreads,
            approvalModes: isAgentMode
              ? { ...remainingApprovalModes, [toThreadId]: approvalMode }
              : remainingApprovalModes,
            workspaces:
              isAgentMode && workspace
                ? { ...remainingWorkspaces, [toThreadId]: workspace }
                : remainingWorkspaces,
          }
        })
      },

      removeThread: (threadId) => {
        set((state) => {
          const agentThreads = { ...state.agentThreads }
          const approvalModes = { ...state.approvalModes }
          const workspaces = { ...state.workspaces }
          delete agentThreads[threadId]
          delete approvalModes[threadId]
          delete workspaces[threadId]
          return { agentThreads, approvalModes, workspaces }
        })
      },

      clearAll: () => {
        set({
          agentThreads: {},
          approvalModes: {},
          workspaces: {},
          sidebarMode: 'chat',
        })
      },
    }),
    {
      name: localStorageKey.agentMode,
      storage: createJSONStorage(() => localStorage),
      version: 2,
      migrate: (persistedState: unknown, version) => {
        const state = (persistedState ?? {}) as Record<string, unknown>
        let workspaces = state.workspaces as
          | Record<string, AgentWorkspace>
          | undefined
        if (version < 1 && state.workingDirs) {
          const workingDirs = state.workingDirs as Record<string, string>
          workspaces = Object.fromEntries(
            Object.entries(workingDirs).map(([threadId, path]) => [
              threadId,
              {
                primaryRoot: {
                  rootId: `legacy:${path}`,
                  path,
                  name: path.split(/[\\/]/).filter(Boolean).at(-1) ?? path,
                  canEdit: true,
                },
                externalRoots: [],
              },
            ])
          )
        }
        if (!workspaces) return state
        return {
          ...state,
          workspaces: Object.fromEntries(
            Object.entries(workspaces).map(([threadId, workspace]) => [
              threadId,
              {
                ...workspace,
                primaryRoot: workspace.primaryRoot
                  ? { ...workspace.primaryRoot, canEdit: true }
                  : undefined,
                externalRoots: workspace.externalRoots.map((root) => ({
                  ...root,
                  canEdit: root.canEdit !== false,
                })),
              },
            ])
          ),
        }
      },
    }
  )
)
