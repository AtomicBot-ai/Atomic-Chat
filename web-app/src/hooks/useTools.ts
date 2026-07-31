import { useEffect } from 'react'
import { getServiceHub } from '@/hooks/useServiceHub'
import { SystemEvent } from '@/types/events'
import { useAppState } from './useAppState'
import { useToolAvailable } from './useToolAvailable'
import { ExtensionManager } from '@/lib/extension'
import { ExtensionTypeEnum, MCPExtension } from '@janhq/core'

type ToolSnapshot = Awaited<ReturnType<typeof fetchToolSnapshot>>

let inFlightSnapshot: Promise<ToolSnapshot> | undefined
let requestedRefreshVersion = 0
let processedRefreshVersion = 0
let refreshLoop: Promise<void> | undefined
let mcpUpdateUnsubscribe: (() => void) | undefined
let mcpUpdateListener: Promise<() => void> | undefined
const refreshSubscribers = new Set<(snapshot: ToolSnapshot) => void>()

async function fetchToolSnapshot() {
  const [response, ragToolNames] = await Promise.all([
    getServiceHub().mcp().getToolsWithStatus(),
    getServiceHub().rag().getToolNames?.() ?? Promise.resolve([]),
  ])
  return { mcpTools: response.tools, ragToolNames }
}

function getToolSnapshot() {
  if (!inFlightSnapshot) {
    const request = fetchToolSnapshot()
    const trackedRequest = request.finally(() => {
      if (inFlightSnapshot === trackedRequest) {
        inFlightSnapshot = undefined
      }
    })
    inFlightSnapshot = trackedRequest
  }
  return inFlightSnapshot
}

function queueFreshToolSnapshot() {
  requestedRefreshVersion += 1
  ensureRefreshLoop()
}

function ensureRefreshLoop() {
  if (refreshLoop) return

  refreshLoop = (async () => {
    while (processedRefreshVersion < requestedRefreshVersion) {
      const targetVersion = requestedRefreshVersion
      if (inFlightSnapshot) {
        await inFlightSnapshot.catch(() => undefined)
      }
      try {
        const snapshot = await getToolSnapshot()
        refreshSubscribers.forEach((subscriber) => subscriber(snapshot))
      } catch (error) {
        console.error('Failed to fetch MCP tools:', error)
      }
      processedRefreshVersion = targetVersion
    }
  })().finally(() => {
    refreshLoop = undefined
    if (processedRefreshVersion < requestedRefreshVersion) {
      ensureRefreshLoop()
    }
  })
}

function subscribeToMcpUpdates(refresh: (snapshot: ToolSnapshot) => void) {
  refreshSubscribers.add(refresh)

  if (!mcpUpdateListener) {
    mcpUpdateListener = getServiceHub()
      .events()
      .listen(SystemEvent.MCP_UPDATE, () => {
        queueFreshToolSnapshot()
      })
      .then((unsubscribe) => {
        mcpUpdateUnsubscribe = unsubscribe
        return unsubscribe
      })
      .catch((error) => {
        mcpUpdateListener = undefined
        console.error('Failed to set up MCP update listener:', error)
        return () => {}
      })
  }

  return () => {
    refreshSubscribers.delete(refresh)
    if (refreshSubscribers.size === 0) {
      if (mcpUpdateUnsubscribe) {
        mcpUpdateUnsubscribe()
        mcpUpdateUnsubscribe = undefined
        mcpUpdateListener = undefined
      } else {
        void mcpUpdateListener?.then((unsubscribe) => {
          if (refreshSubscribers.size === 0) {
            unsubscribe()
            mcpUpdateUnsubscribe = undefined
            mcpUpdateListener = undefined
          }
        })
      }
    }
  }
}

export const useTools = () => {
  const updateTools = useAppState((state) => state.updateTools)
  const updateRagToolNames = useAppState((state) => state.updateRagToolNames)
  const updateMcpToolNames = useAppState((state) => state.updateMcpToolNames)
  const { isDefaultsInitialized, setDefaultDisabledTools, markDefaultsAsInitialized } = useToolAvailable()

  useEffect(() => {
    async function setTools(snapshot: ToolSnapshot) {
      try {
        // Get MCP extension first
        const mcpExtension = ExtensionManager.getInstance().get<MCPExtension>(
          ExtensionTypeEnum.MCP
        )

        const { mcpTools, ragToolNames } = snapshot

        // Update MCP tools
        updateTools(mcpTools)

        // Update cached tool names for fast synchronous access
        updateMcpToolNames(mcpTools.map((t) => t.name))
        updateRagToolNames(ragToolNames)

        // Initialize default disabled tools for new users (only once)
        if (!isDefaultsInitialized() && mcpTools.length > 0 && mcpExtension?.getDefaultDisabledTools) {
          const defaultDisabled = await mcpExtension.getDefaultDisabledTools()
          if (defaultDisabled.length > 0) {
            setDefaultDisabledTools(defaultDisabled)
            markDefaultsAsInitialized()
          }
        }
      } catch (error) {
        console.error('Failed to fetch MCP tools:', error)
      }
    }
    void getToolSnapshot()
      .then(setTools)
      .catch((error) => {
        console.error('Failed to fetch MCP tools:', error)
      })
    return subscribeToMcpUpdates((snapshot) => {
      void setTools(snapshot)
    })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [])
}
