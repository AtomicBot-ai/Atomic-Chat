import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'

type UseMCPServerToggleOptions = {
  // Kept for call-site symmetry with the composer's other toggles; the switch
  // itself is global, so nothing here depends on it.
  initialMessage?: boolean
}

/**
 * Connecting/disconnecting an MCP server from the composer.
 *
 * Same dance WebSearchToggle does for the globe button: activate first and
 * only then write `active: true`, so a server that fails to spawn never gets
 * persisted as running. Per-tool switches (the connector's tools dialog) are
 * left alone: a tool the user turned off stays off across a restart, and the
 * dialog is where that shows and where it is undone.
 */
export function useMCPServerToggle(
  // eslint-disable-next-line @typescript-eslint/no-unused-vars
  _options: UseMCPServerToggleOptions = {}
) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const editServer = useMCPServers((state) => state.editServer)
  const syncServers = useMCPServers((state) => state.syncServers)

  const [pendingServers, setPendingServers] = useState<Record<string, boolean>>(
    {}
  )

  const toggleServer = useCallback(
    async (key: string, config: MCPServerConfig, next: boolean) => {
      if (pendingServers[key]) return
      setPendingServers((prev) => ({ ...prev, [key]: true }))
      const toastId = `connector-toggle-${key}`
      toast.loading(
        t(
          next
            ? 'common:connectorsMenu.starting'
            : 'common:connectorsMenu.stopping',
          { server: key }
        ),
        {
          id: toastId,
          description: t(
            next
              ? 'common:connectorsMenu.connecting'
              : 'common:connectorsMenu.disconnecting'
          ),
          duration: Infinity,
        }
      )
      // Keep the switch itself stable and immediate. The snackbar owns the
      // asynchronous progress; failure below rolls this optimistic state back.
      editServer(key, { ...config, active: next })
      try {
        if (next) {
          await serviceHub
            .mcp()
            .activateMCPServer(key, { ...config, active: true })
          await syncServers()
        } else {
          await syncServers()
          await serviceHub.mcp().deactivateMCPServer(key)
        }
        toast.success(
          t(
            next
              ? 'common:connectorsMenu.ready'
              : 'common:connectorsMenu.stopped',
            { server: key }
          ),
          { id: toastId }
        )
      } catch (error) {
        editServer(key, { ...config, active: !next })
        await syncServers()
        toast.error(
          t('common:connectorsMenu.toggleFailed', { server: key }),
          {
            id: toastId,
            description:
              error instanceof Error ? error.message : String(error),
          }
        )
      } finally {
        setPendingServers((prev) => ({ ...prev, [key]: false }))
      }
    },
    [editServer, pendingServers, serviceHub, syncServers, t]
  )

  const isServerPending = useCallback(
    (key: string) => Boolean(pendingServers[key]),
    [pendingServers]
  )

  return { toggleServer, isServerPending }
}
