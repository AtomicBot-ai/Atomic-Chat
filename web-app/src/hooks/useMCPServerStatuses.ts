import { useCallback, useEffect, useMemo, useState } from 'react'
import { SystemEvent } from '@/types/events'
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
    let detachers: Array<() => void> = []
    const setupListeners = async () => {
      // Subscribe through the service hub rather than `@tauri-apps/api/event`
      // directly: the hub hands back an already-idempotent detacher, and on a
      // platform without the Tauri bridge it resolves to the web no-op instead
      // of throwing on `transformCallback`.
      const safeDetachers = await Promise.all([
        serviceHub.events().listen(SystemEvent.MCP_UPDATE, refresh),
        serviceHub.events().listen(SystemEvent.MCP_STATUS_UPDATE, refresh),
      ])
      if (cancelled) {
        safeDetachers.forEach((detach) => detach())
      } else {
        detachers = safeDetachers
      }
    }
    // A rejected setup must not surface as an unhandled rejection.
    void setupListeners().catch((error) => {
      console.warn('Failed to subscribe to MCP status events', error)
    })

    return () => {
      cancelled = true
      detachers.splice(0).forEach((detach) => detach())
    }
  }, [refresh, serviceHub])

  const statusByName = useMemo(
    () => new Map(statuses.map((status) => [status.name, status])),
    [statuses]
  )

  return { statuses, statusByName, refresh }
}
