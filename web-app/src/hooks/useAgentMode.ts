import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type AgentApprovalMode = 'manual' | 'skip'
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

/**
 * Per-thread agent state: approval mode and workspace roots.
 *
 * Historically this store also carried the chat/agent split
 * (`agentThreads`, `sidebarMode`). Since the merge every thread runs on the
 * agent engine, so v3 dropped both — routing now lives in
 * `lib/agent-route.ts` and is provider-based, not mode-based.
 */
type AgentModeState = {
  approvalModes: Record<string, AgentApprovalMode>
  workspaces: Record<string, AgentWorkspace>

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
  setApprovalMode: (threadId: string, mode: AgentApprovalMode) => void
  setWorkingDir: (threadId: string, workingDir: string) => void
  /**
   * Move the composer key's state (approval mode, workspace) onto the real
   * thread once it exists — the TEMPORARY_CHAT_ID → thread id handoff.
   * Unconditional: every thread is an agent thread now.
   */
  transferThreadState: (fromThreadId: string, toThreadId: string) => void
  removeThread: (threadId: string) => void
  /** Clear per-thread agent state for all threads. */
  clearAll: () => void
}

export const useAgentMode = create<AgentModeState>()(
  persist(
    (set, get) => ({
      approvalModes: {},
      workspaces: {},

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

      transferThreadState: (fromThreadId, toThreadId) => {
        set((state) => {
          const approvalMode = state.approvalModes[fromThreadId]
          const workspace = state.workspaces[fromThreadId]
          const approvalModes = { ...state.approvalModes }
          const workspaces = { ...state.workspaces }
          delete approvalModes[fromThreadId]
          delete workspaces[fromThreadId]
          if (approvalMode !== undefined) {
            approvalModes[toThreadId] = approvalMode
          } else {
            delete approvalModes[toThreadId]
          }
          if (workspace !== undefined) {
            workspaces[toThreadId] = workspace
          } else {
            delete workspaces[toThreadId]
          }
          return { approvalModes, workspaces }
        })
      },

      removeThread: (threadId) => {
        set((state) => {
          const approvalModes = { ...state.approvalModes }
          const workspaces = { ...state.workspaces }
          delete approvalModes[threadId]
          delete workspaces[threadId]
          return { approvalModes, workspaces }
        })
      },

      clearAll: () => {
        set({
          approvalModes: {},
          workspaces: {},
        })
      },
    }),
    {
      name: localStorageKey.agentMode,
      storage: createJSONStorage(() => localStorage),
      version: 3,
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
        if (version < 2 && workspaces) {
          workspaces = Object.fromEntries(
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
          )
        }
        if (workspaces) {
          state.workspaces = workspaces
        }
        if (version < 3) {
          // v3: the chat/agent split is gone — every thread runs on the agent
          // engine. Approval modes and workspaces survive untouched.
          delete state.agentThreads
          delete state.sidebarMode
        }
        return state
      },
    }
  )
)
