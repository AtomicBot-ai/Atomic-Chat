import { create } from 'zustand'
import { persist, createJSONStorage } from 'zustand/middleware'
import { localStorageKey } from '@/constants/localStorage'
import { MCPTool } from '@/types/completion'

// Helper function to create composite key for server+tool
export const createToolKey = (serverName: string, toolName: string) => {
  return `${serverName}::${toolName}`
}

const withKeys = (current: string[], keys: string[], disabled: boolean) => {
  if (disabled) return [...new Set([...current, ...keys])]
  const drop = new Set(keys)
  return current.filter((key) => !drop.has(key))
}

const isOldFormatKey = (key: string): boolean => {
  return !key.includes('::')
}

const migrateOldFormatIfNeeded = (
  disabledTools: Record<string, string[]>,
  defaultDisabledTools: string[]
): {
  disabledTools: Record<string, string[]>
  defaultDisabledTools: string[]
} => {
  const needsMigration =
    Object.values(disabledTools).some((tools) => tools.some(isOldFormatKey)) ||
    defaultDisabledTools.some(isOldFormatKey)

  if (!needsMigration) {
    return { disabledTools, defaultDisabledTools }
  }

  console.log(
    '[useToolAvailable] Migrating tool availability settings to new format (server::tool)'
  )

  return {
    disabledTools: {},
    defaultDisabledTools: [],
  }
}

type ToolDisabledState = {
  // Track disabled tools per thread using server::tool composite keys
  disabledTools: Record<string, string[]> // threadId -> toolKeys[] (server::tool format)
  // Global default disabled tools (for new threads/index page) using composite keys
  defaultDisabledTools: string[]
  // Flag to track if defaults have been initialized from extension
  defaultsInitialized: boolean
  // Connectors switched off for one chat only (server keys). The server keeps
  // running for other chats and for agent mode; its tools just stay out of
  // this thread's requests. Unlike `disabledTools`, these keys are never
  // swept as "stale" by the plugins menu.
  mutedServers: Record<string, string[]> // threadId -> server keys
  // Default for new threads / the index page.
  defaultMutedServers: string[]

  // Actions - now require both server and tool name
  setToolDisabledForThread: (
    threadId: string,
    serverName: string,
    toolName: string,
    available: boolean
  ) => void
  // Bulk form of the above for the tools dialog: one store write (and one
  // localStorage write) for a whole connector instead of one per tool.
  setToolsDisabledForThread: (
    threadId: string,
    toolKeys: string[],
    disabled: boolean
  ) => void
  isToolDisabled: (
    threadId: string,
    serverName: string,
    toolName: string
  ) => boolean
  getDisabledToolsForThread: (threadId: string) => string[]
  setDefaultDisabledTools: (toolKeys: string[]) => void
  setDefaultToolsDisabled: (toolKeys: string[], disabled: boolean) => void
  getDefaultDisabledTools: () => string[]
  isDefaultsInitialized: () => boolean
  markDefaultsAsInitialized: () => void
  // Initialize thread tools from default or existing thread settings
  initializeThreadTools: (threadId: string, allTools: MCPTool[]) => void

  setServerMutedForThread: (
    threadId: string,
    serverKey: string,
    muted: boolean
  ) => void
  getMutedServersForThread: (threadId: string) => string[]
  isServerMutedForThread: (threadId: string, serverKey: string) => boolean
  setDefaultServerMuted: (serverKey: string, muted: boolean) => void
  getDefaultMutedServers: () => string[]
}

export const useToolAvailable = create<ToolDisabledState>()(
  persist(
    (set, get) => ({
      disabledTools: {},
      defaultDisabledTools: [],
      defaultsInitialized: false,
      mutedServers: {},
      defaultMutedServers: [],

      setServerMutedForThread: (threadId, serverKey, muted) => {
        set((state) => {
          const current =
            state.mutedServers[threadId] ?? state.defaultMutedServers
          const next = muted
            ? [...new Set([...current, serverKey])]
            : current.filter((key) => key !== serverKey)
          return {
            mutedServers: { ...state.mutedServers, [threadId]: next },
          }
        })
      },

      getMutedServersForThread: (threadId) => {
        const state = get()
        return state.mutedServers[threadId] ?? state.defaultMutedServers
      },

      isServerMutedForThread: (threadId, serverKey) =>
        get().getMutedServersForThread(threadId).includes(serverKey),

      setDefaultServerMuted: (serverKey, muted) => {
        set((state) => ({
          defaultMutedServers: muted
            ? [...new Set([...state.defaultMutedServers, serverKey])]
            : state.defaultMutedServers.filter((key) => key !== serverKey),
        }))
      },

      getDefaultMutedServers: () => get().defaultMutedServers,

      setToolDisabledForThread: (
        threadId: string,
        serverName: string,
        toolName: string,
        available: boolean
      ) => {
        get().setToolsDisabledForThread(
          threadId,
          [createToolKey(serverName, toolName)],
          !available
        )
      },

      setToolsDisabledForThread: (threadId, toolKeys, disabled) => {
        set((state) => {
          // A thread without its own entry has been running on the defaults,
          // so its first switch starts from them — not from an empty list
          // that would silently re-enable every default-off tool.
          const current =
            state.disabledTools[threadId] ?? state.defaultDisabledTools
          return {
            disabledTools: {
              ...state.disabledTools,
              [threadId]: withKeys(current, toolKeys, disabled),
            },
          }
        })
      },

      isToolDisabled: (
        threadId: string,
        serverName: string,
        toolName: string
      ) => {
        const state = get()
        const toolKey = createToolKey(serverName, toolName)
        // If no thread-specific settings, use default
        if (!state.disabledTools[threadId]) {
          return state.defaultDisabledTools.includes(toolKey)
        }
        return state.disabledTools[threadId]?.includes(toolKey) || false
      },

      getDisabledToolsForThread: (threadId: string) => {
        const state = get()
        // If no thread-specific settings, use default
        if (!state.disabledTools[threadId]) {
          return state.defaultDisabledTools
        }
        return state.disabledTools[threadId] || []
      },

      setDefaultDisabledTools: (toolKeys: string[]) => {
        set({ defaultDisabledTools: toolKeys })
      },

      setDefaultToolsDisabled: (toolKeys, disabled) => {
        set((state) => ({
          defaultDisabledTools: withKeys(
            state.defaultDisabledTools,
            toolKeys,
            disabled
          ),
        }))
      },

      getDefaultDisabledTools: () => {
        return get().defaultDisabledTools
      },

      isDefaultsInitialized: () => {
        return get().defaultsInitialized
      },

      markDefaultsAsInitialized: () => {
        set({ defaultsInitialized: true })
      },

      initializeThreadTools: (threadId: string, allTools: MCPTool[]) => {
        const state = get()
        // If thread already has settings, don't override
        if (state.disabledTools[threadId]) {
          return
        }

        // Initialize with default tools only
        // Don't auto-enable all tools if defaults are explicitly empty
        const initialTools = state.defaultDisabledTools.filter((toolKey) =>
          allTools.some(
            (tool) => createToolKey(tool.server, tool.name) === toolKey
          )
        )

        set((currentState) => ({
          disabledTools: {
            ...currentState.disabledTools,
            [threadId]: initialTools,
          },
        }))
      },
    }),
    {
      name: localStorageKey.toolAvailability,
      storage: createJSONStorage(() => localStorage),
      // Persist all state
      partialize: (state) => ({
        disabledTools: state.disabledTools,
        defaultDisabledTools: state.defaultDisabledTools,
        defaultsInitialized: state.defaultsInitialized,
        mutedServers: state.mutedServers,
        defaultMutedServers: state.defaultMutedServers,
      }),
      // Migration function to handle old format data
      migrate: (persistedState: unknown) => {
        if (persistedState && typeof persistedState === 'object') {
          const state = persistedState as Record<string, unknown>
          const migrated = migrateOldFormatIfNeeded(
            (state.disabledTools as Record<string, string[]>) || {},
            (state.defaultDisabledTools as string[]) || []
          )

          return {
            ...state,
            disabledTools: migrated.disabledTools,
            defaultDisabledTools: migrated.defaultDisabledTools,
            defaultsInitialized:
              migrated.disabledTools === state.disabledTools
                ? state.defaultsInitialized
                : false,
          }
        }
        return persistedState
      },
      version: 1, // Increment version to trigger migration
    }
  )
)
