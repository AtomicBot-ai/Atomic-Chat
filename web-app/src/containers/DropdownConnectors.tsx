import React, { memo, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconLoader2, IconSettings } from '@tabler/icons-react'

import {
  DropDrawer,
  DropDrawerContent,
  DropDrawerGroup,
  DropDrawerItem,
  DropDrawerLabel,
  DropDrawerSeparator,
  DropDrawerTrigger,
} from '@/components/ui/dropdrawer'
import { Switch } from '@/components/ui/switch'

import { ConnectorIcon } from '@/containers/connectors/ConnectorIcon'
import {
  HIDDEN_SERVER_KEYS,
  MCP_CONNECTORS,
  findInstalledServer,
  type MCPConnector,
} from '@/constants/mcp-connectors'
import { route } from '@/constants/routes'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServerStatuses } from '@/hooks/useMCPServerStatuses'
import { useMCPServerToggle } from '@/hooks/useMCPServerToggle'
import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'
import { useThreads } from '@/hooks/useThreads'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { MCPTool } from '@/types/completion'

interface DropdownConnectorsProps {
  // (isOpen, number of connected connectors) -> trigger
  children: (isOpen: boolean, activeConnectors: number) => React.ReactNode
  initialMessage?: boolean
  onOpenChange?: (isOpen: boolean) => void
}

type ConnectorEntry = {
  key: string
  connector?: MCPConnector
  config?: MCPServerConfig
  active: boolean
  tools: MCPTool[]
}

/** Brand tile for catalog connectors, monogram for anything hand-added. */
function ServerIcon({
  connector,
  name,
}: {
  connector?: MCPConnector
  name: string
}) {
  if (connector)
    return (
      <ConnectorIcon
        connector={connector}
        className="size-5 rounded-sm [&>span]:text-[10px]"
      />
    )
  return (
    <div className="flex size-5 shrink-0 items-center justify-center overflow-hidden rounded-sm bg-muted">
      <span className="text-[10px] font-semibold uppercase text-muted-foreground">
        {name.charAt(0)}
      </span>
    </div>
  )
}

/**
 * Connectors menu for the composer: one row per MCP server, one switch each.
 *
 * The switch is the whole connector — every tool it exposes goes on or off
 * with it. There is deliberately no per-tool drill-down: picking tools one by
 * one was more bookkeeping than anyone wanted, and a half-muted server is a
 * state nothing in the UI could show honestly.
 */
export default memo(function DropdownConnectors({
  children,
  initialMessage = false,
  onOpenChange,
}: DropdownConnectorsProps) {
  const [isOpen, setIsOpen] = useState(false)
  const { t } = useTranslation()
  const navigate = useNavigate()

  const allTools = useAppState((state) => state.tools)
  const mcpServers = useMCPServers((state) => state.mcpServers)
  const { statusByName } = useMCPServerStatuses()
  const { toggleServer, isServerPending } = useMCPServerToggle({
    initialMessage,
  })

  // Filter out Jan Browser MCP tools — the Browse button owns that server.
  const tools = useMemo(
    () => allTools.filter((tool) => !HIDDEN_SERVER_KEYS.includes(tool.server)),
    [allTools]
  )

  const { getCurrentThread } = useThreads()
  const {
    getDefaultDisabledTools,
    setDefaultDisabledTools,
    getDisabledToolsForThread,
    setToolDisabledForThread,
  } = useToolAvailable()
  const currentThread = getCurrentThread()

  const handleOpenChange = (open: boolean) => {
    setIsOpen(open)
    onOpenChange?.(open)
  }

  const connectorByServerKey = useMemo(() => {
    const map = new Map<string, MCPConnector>()
    for (const connector of MCP_CONNECTORS) {
      const hit = findInstalledServer(connector, mcpServers)
      if (hit) map.set(hit.key, connector)
    }
    return map
  }, [mcpServers])

  const toolsByServer = useMemo(() => {
    return tools.reduce(
      (acc, tool) => {
        if (!acc[tool.server]) acc[tool.server] = []
        acc[tool.server].push(tool)
        return acc
      },
      {} as Record<string, MCPTool[]>
    )
  }, [tools])

  // Configured servers first (their stored order), then anything that only
  // shows up as a running tool source — an extension-provided server, say.
  const entries = useMemo<ConnectorEntry[]>(() => {
    const configured = Object.entries(mcpServers)
      .filter(([key]) => !HIDDEN_SERVER_KEYS.includes(key))
      .map(([key, config]) => ({
        key,
        connector: connectorByServerKey.get(key),
        config,
        active: Boolean(config.active),
        tools: toolsByServer[key] ?? [],
      }))
    const known = new Set(configured.map((entry) => entry.key))
    const extra = Object.keys(toolsByServer)
      .filter((server) => !known.has(server))
      .map((server) => ({
        key: server,
        connector: connectorByServerKey.get(server),
        config: undefined,
        active: true,
        tools: toolsByServer[server],
      }))
    return [...configured, ...extra]
  }, [connectorByServerKey, mcpServers, toolsByServer])

  // A connector that is on runs all of its tools. Older builds let single
  // tools be muted, and those leftovers would otherwise sit in storage with
  // nothing left to show or clear them, so drop them on sight.
  const threadId = initialMessage ? undefined : currentThread?.id
  useEffect(() => {
    const activePrefixes = entries
      .filter((entry) => entry.active)
      .map((entry) => `${entry.key}::`)
    if (activePrefixes.length === 0) return
    const isStale = (key: string) =>
      activePrefixes.some((prefix) => key.startsWith(prefix))

    if (threadId) {
      const muted = getDisabledToolsForThread(threadId).filter(isStale)
      muted.forEach((key) => {
        const [server, ...rest] = key.split('::')
        setToolDisabledForThread(threadId, server, rest.join('::'), true)
      })
      return
    }
    const defaults = getDefaultDisabledTools()
    if (defaults.some(isStale)) {
      setDefaultDisabledTools(defaults.filter((key) => !isStale(key)))
    }
  }, [
    entries,
    getDefaultDisabledTools,
    getDisabledToolsForThread,
    setDefaultDisabledTools,
    setToolDisabledForThread,
    threadId,
  ])

  const activeConnectors = entries.filter((entry) => entry.active).length

  const goToConnectors = () => {
    navigate({ to: route.connectors.index })
  }

  const renderServerSwitch = (entry: ConnectorEntry) => {
    const label = entry.connector?.name ?? entry.key
    // A tools-only server has no stored config to flip, so it stays read-only.
    if (!entry.config) {
      return <Switch checked disabled aria-label={label} />
    }
    if (isServerPending(entry.key)) {
      return (
        <IconLoader2 size={16} className="animate-spin text-muted-foreground" />
      )
    }
    return (
      <Switch
        aria-label={label}
        checked={entry.active}
        onCheckedChange={(checked) => {
          void toggleServer(entry.key, entry.config as MCPServerConfig, checked)
        }}
        onClick={(e) => {
          e.stopPropagation()
        }}
      />
    )
  }

  const renderTrigger = () => children(isOpen, activeConnectors)

  return (
    <DropDrawer onOpenChange={handleOpenChange}>
      <DropDrawerTrigger asChild>{renderTrigger()}</DropDrawerTrigger>
      <DropDrawerContent
        side="top"
        align="start"
        className="overflow-hidden! min-w-64"
        onClick={(e) => e.stopPropagation()}
      >
        <DropDrawerLabel className="flex items-center gap-2 sticky -top-1 z-10 px-4 pl-2 py-1">
          {t('common:connectorsMenu.title')}
        </DropDrawerLabel>
        <DropDrawerSeparator />
        <div className="max-h-64 overflow-y-auto">
          <DropDrawerGroup>
            {entries.length === 0 && (
              <DropDrawerItem disabled>
                {t('common:connectorsMenu.empty')}
              </DropDrawerItem>
            )}
            {entries.map((entry) => {
              const status = statusByName.get(entry.key)
              const isError = entry.active && status?.status === 'error'
              const name = entry.connector?.name ?? entry.key
              return (
                <DropDrawerItem
                  key={entry.key}
                  className="py-2"
                  onSelect={(e) => e.preventDefault()}
                  onClick={(e) => e.preventDefault()}
                  icon={
                    <div className="flex shrink-0 items-center gap-2">
                      {entry.active && entry.tools.length > 0 && (
                        <span
                          className="text-xs text-muted-foreground inline-flex items-center border px-1 rounded-sm"
                          title={t('common:connectorsMenu.toolCount', {
                            count: entry.tools.length,
                          })}
                        >
                          {entry.tools.length}
                        </span>
                      )}
                      {renderServerSwitch(entry)}
                    </div>
                  }
                >
                  <div className="flex min-w-0 items-center gap-2">
                    <ServerIcon connector={entry.connector} name={name} />
                    <span
                      className="truncate text-sm"
                      title={isError ? status?.error : undefined}
                    >
                      {name}
                    </span>
                    {isError && (
                      <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
                    )}
                  </div>
                </DropDrawerItem>
              )
            })}
          </DropDrawerGroup>
        </div>
        <DropDrawerSeparator />
        <DropDrawerItem className="py-2" onSelect={goToConnectors}>
          <div className="flex items-center gap-2">
            <IconSettings size={16} className="text-muted-foreground" />
            <span className="text-sm">{t('common:connectorsMenu.manage')}</span>
          </div>
        </DropDrawerItem>
      </DropDrawerContent>
    </DropDrawer>
  )
})
