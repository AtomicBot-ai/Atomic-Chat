import { useCallback, useEffect, useMemo, useState } from 'react'
import { listen } from '@tauri-apps/api/event'
import { SystemEvent } from '@/types/events'
import { createSafeUnlisten } from '@/lib/tauriEvent'
import { useServiceHub } from '@/hooks/useServiceHub'
import type { MCPServerStatus } from '@/services/mcp/types'

/**
 * Live MCP server statuses: fetched once on mount and refreshed on the
 * backend's mcp-update / mcp-status-update events. A server absent from the
 * list is simply inactive (the backend only reports connected/error).
 */
export function useMCPServerStatuses(): {
  statuses: MCPServerStatus[]
  statusByName: Map<string, MCPServerStatus>
  refresh: () => void
} {
  const serviceHub = useServiceHub()
  const [statuses, setStatuses] = useState<MCPServerStatus[]>([])

  const refresh = useCallback(() => {
    serviceHub.mcp().getMCPServerStatuses().then(setStatuses)
  }, [serviceHub])

  useEffect(() => {
    refresh()

    let cancelled = false
    let detachers: Array<() => Promise<void>> = []
    const setupListeners = async () => {
      const listeners = await Promise.all([
        listen(SystemEvent.MCP_UPDATE, refresh),
        listen(SystemEvent.MCP_STATUS_UPDATE, refresh),
      ])
      const safeDetachers = listeners.map((unsubscribe) =>
        createSafeUnlisten(unsubscribe)
      )
      if (cancelled) {
        safeDetachers.forEach((detach) => void detach())
      } else {
        detachers = safeDetachers
      }
    }
    void setupListeners()

    return () => {
      cancelled = true
      detachers.splice(0).forEach((detach) => void detach())
    }
  }, [refresh])

  const statusByName = useMemo(
    () => new Map(statuses.map((status) => [status.name, status])),
    [statuses]
  )

  return { statuses, statusByName, refresh }
}
