import { useCallback, useState } from 'react'
import { toast } from 'sonner'

import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useTranslation } from '@/i18n/react-i18next-compat'

type UseMCPServerToggleOptions = {
  // The index page edits the defaults for new threads instead of a thread.
  initialMessage?: boolean
}

/**
 * Connecting/disconnecting an MCP server from the composer.
 *
 * Same dance WebSearchToggle does for the globe button: activate first and
 * only then write `active: true`, so a server that fails to spawn never gets
 * persisted as running. Per-tool switches are cleared on the way up, or the
 * server comes back with all of its tools still muted.
 */
export function useMCPServerToggle({
  initialMessage = false,
}: UseMCPServerToggleOptions = {}) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const editServer = useMCPServers((state) => state.editServer)
  const syncServers = useMCPServers((state) => state.syncServers)

  const { getCurrentThread } = useThreads()
  const {
    getDefaultDisabledTools,
    setDefaultDisabledTools,
    getDisabledToolsForThread,
    setToolDisabledForThread,
  } = useToolAvailable()

  const [pendingServers, setPendingServers] = useState<Record<string, boolean>>(
    {}
  )

  const enableServerTools = useCallback(
    (serverKey: string) => {
      const prefix = `${serverKey}::`
      const threadId = initialMessage ? undefined : getCurrentThread()?.id
      if (threadId) {
        getDisabledToolsForThread(threadId)
          .filter((key) => key.startsWith(prefix))
          .forEach((key) =>
            setToolDisabledForThread(
              threadId,
              serverKey,
              key.slice(prefix.length),
              true
            )
          )
        return
      }
      setDefaultDisabledTools(
        getDefaultDisabledTools().filter((key) => !key.startsWith(prefix))
      )
    },
    [
      getCurrentThread,
      getDefaultDisabledTools,
      getDisabledToolsForThread,
      initialMessage,
      setDefaultDisabledTools,
      setToolDisabledForThread,
    ]
  )

  const toggleServer = useCallback(
    async (key: string, config: MCPServerConfig, next: boolean) => {
      if (pendingServers[key]) return
      setPendingServers((prev) => ({ ...prev, [key]: true }))
      try {
        if (next) {
          await serviceHub
            .mcp()
            .activateMCPServer(key, { ...config, active: true })
          editServer(key, { ...config, active: true })
          enableServerTools(key)
          await syncServers()
        } else {
          editServer(key, { ...config, active: false })
          await syncServers()
          await serviceHub.mcp().deactivateMCPServer(key)
        }
      } catch (error) {
        // The activation failed, so leave the stored config off to match reality.
        editServer(key, { ...config, active: false })
        await syncServers()
        toast.error(t('common:connectorsMenu.toggleFailed', { server: key }), {
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setPendingServers((prev) => ({ ...prev, [key]: false }))
      }
    },
    [editServer, enableServerTools, pendingServers, serviceHub, syncServers, t]
  )

  const isServerPending = useCallback(
    (key: string) => Boolean(pendingServers[key]),
    [pendingServers]
  )

  return { toggleServer, isServerPending }
}
