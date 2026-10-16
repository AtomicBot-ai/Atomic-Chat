import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'

export type ShowApprovalModalOptions = {
  /**
   * Prompt even while the global "Allow all MCP permissions" switch is on.
   * Used when the thread's approval mode was explicitly set to manual — the
   * composer select outranks the global switch there.
   */
  bypassGlobalAutoApprove?: boolean
}

export type ToolApprovalModalProps = {
  toolName: string
  threadId: string
  toolParameters?: object
  onApprove: (allowOnce: boolean) => void
  onDeny: () => void
}

/**
 * Version of the persisted tool-approval state.
 *
 * - v1 forced `allowAllMCPPermissions` on for everyone (an inherited upstream
 *   default, never a user choice).
 * - v2 resets it to off once, so every MCP tool call asks again. A user who
 *   turns it back on afterwards keeps that choice: the reset never re-runs.
 */
export const TOOL_APPROVAL_STORE_VERSION = 2

type PersistedToolApprovalState = Pick<
  ToolApprovalState,
  'approvedTools' | 'allowAllMCPPermissions'
>

/**
 * Upgrade persisted tool-approval state from `fromVersion` to
 * {@link TOOL_APPROVAL_STORE_VERSION}. Per-thread approvals ("Always allow"
 * for one tool) are deliberate user choices and survive every step.
 */
export function migrateToolApprovalState(
  persistedState: unknown,
  fromVersion: number
): PersistedToolApprovalState {
  const state = (persistedState ?? {}) as Partial<PersistedToolApprovalState>
  const migrated: PersistedToolApprovalState = {
    approvedTools: state.approvedTools ?? {},
    allowAllMCPPermissions: state.allowAllMCPPermissions ?? false,
  }
  if (fromVersion < 2) {
    migrated.allowAllMCPPermissions = false
  }
  return migrated
}

type ToolApprovalState = {
  // Track approved tools per thread
  approvedTools: Record<string, string[]> // threadId -> toolNames[]
  /**
   * Explicit opt-in to run every MCP tool call without asking. Off by default:
   * MCP servers are third-party code acting on the user's behalf.
   */
  allowAllMCPPermissions: boolean
  // Modal state
  isModalOpen: boolean
  modalProps: ToolApprovalModalProps | null

  // Actions
  approveToolForThread: (threadId: string, toolName: string) => void
  isToolApproved: (threadId: string, toolName: string) => boolean
  showApprovalModal: (
    toolName: string,
    threadId: string,
    toolParameters?: object,
    options?: ShowApprovalModalOptions
  ) => Promise<boolean>
  closeModal: () => void
  setModalOpen: (open: boolean) => void
  setAllowAllMCPPermissions: (allow: boolean) => void
}

export const useToolApproval = create<ToolApprovalState>()(
  persist(
    (set, get) => ({
      approvedTools: {},
      allowAllMCPPermissions: false,
      isModalOpen: false,
      modalProps: null,

      approveToolForThread: (threadId: string, toolName: string) => {
        set((state) => ({
          approvedTools: {
            ...state.approvedTools,
            [threadId]: [
              ...(state.approvedTools[threadId] || []),
              toolName,
            ].filter((tool, index, arr) => arr.indexOf(tool) === index), // Remove duplicates
          },
        }))
      },

      isToolApproved: (threadId: string, toolName: string) => {
        const state = get()
        return state.approvedTools[threadId]?.includes(toolName) || false
      },

      showApprovalModal: (
        toolName: string,
        threadId: string,
        toolParameters?: object,
        options?: ShowApprovalModalOptions
      ) => {
        return new Promise<boolean>((resolve) => {
          const state = get()

          // The user explicitly opted in to run MCP tools without asking
          if (
            state.allowAllMCPPermissions &&
            !options?.bypassGlobalAutoApprove
          ) {
            resolve(true)
            return
          }

          // Check if tool is already approved for this thread
          if (state.isToolApproved(threadId, toolName)) {
            resolve(true)
            return
          }

          set({
            isModalOpen: true,
            modalProps: {
              toolName,
              threadId,
              toolParameters,
              onApprove: (allowOnce: boolean) => {
                if (!allowOnce) {
                  // If not "allow once", add to approved tools for this thread
                  get().approveToolForThread(threadId, toolName)
                }
                get().closeModal()
                resolve(true)
              },
              onDeny: () => {
                get().closeModal()
                resolve(false)
              },
            },
          })
        })
      },

      closeModal: () => {
        set({
          isModalOpen: false,
          modalProps: null,
        })
      },

      setModalOpen: (open: boolean) => {
        set({ isModalOpen: open })
        if (!open) {
          get().closeModal()
        }
      },

      setAllowAllMCPPermissions: (allow: boolean) => {
        set({ allowAllMCPPermissions: allow })
      },
    }),
    {
      name: localStorageKey.toolApproval,
      storage: createJSONStorage(() => localStorage),
      version: TOOL_APPROVAL_STORE_VERSION,
      migrate: (persistedState, fromVersion) =>
        migrateToolApprovalState(
          persistedState,
          fromVersion
        ) as ToolApprovalState,
      // Only persist approved tools and global permission setting, not modal state
      partialize: (state) => ({
        approvedTools: state.approvedTools,
        allowAllMCPPermissions: state.allowAllMCPPermissions,
      }),
    }
  )
)
