import React, { memo, useEffect, useMemo, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconLoader2, IconSettings } from '@tabler/icons-react'
import { ChevronRight } from 'lucide-react'

import {
  Collapsible,
  CollapsibleContent,
  collapsiblePanelAnimation,
} from '@/components/ui/collapsible'
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

import { ServerIcon } from '@/containers/connectors/ServerIcon'
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
import { cn } from '@/lib/utils'
import type { AgentSkill } from '@/services/agent/skills'
import type { MCPTool } from '@/types/completion'

interface DropdownPluginsProps {
  // (isOpen, number of connected connectors) -> trigger
  children: (isOpen: boolean, activeConnectors: number) => React.ReactNode
  initialMessage?: boolean
  onOpenChange?: (isOpen: boolean) => void
  /**
   * Installed skills, owned by the composer so the slash menu and this menu
   * read the same list. Left out where skills don't exist (the web build),
   * which drops the Skills section entirely.
   */
  skills?: AgentSkill[]
  skillsLoading?: boolean
  onToggleSkill?: (name: string, enabled: boolean) => void
}

type ConnectorEntry = {
  key: string
  connector?: MCPConnector
  config?: MCPServerConfig
  active: boolean
  tools: MCPTool[]
}

/** Collapsible section head: chevron, label, and how many rows are on. */
function SectionHeader({
  label,
  open,
  count,
  onToggle,
}: {
  label: string
  open: boolean
  count: number
  onToggle: () => void
}) {
  return (
    <DropDrawerItem
      className="py-2"
      // The toggle rides on the click, not on the menu's select event: a menu
      // item runs its select through `onClick`, so preventing the default
      // there (which is what keeps the menu — and on mobile the drawer — open)
      // also cancels the select. One handler does both jobs.
      onClick={(e) => {
        e.preventDefault()
        onToggle()
      }}
      icon={
        count > 0 ? (
          <span className="text-xs text-muted-foreground inline-flex items-center border px-1 rounded-sm">
            {count}
          </span>
        ) : undefined
      }
    >
      <div className="flex min-w-0 items-center gap-1.5">
        <ChevronRight
          className={cn(
            'size-4 shrink-0 text-muted-foreground transition-transform duration-200 ease-out',
            open && 'rotate-90'
          )}
        />
        <span className="truncate text-sm font-medium">{label}</span>
      </div>
    </DropDrawerItem>
  )
}

/**
 * Plugins menu for the composer: connectors and skills, one collapsible
 * section each — the same grouping the sidebar uses, so "what is plugged into
 * the model" is one place in both.
 *
 * Every row is a switch over the whole thing. For a connector that means all
 * of its tools go on or off together: picking tools one by one was more
 * bookkeeping than anyone wanted, and a half-muted server is a state nothing
 * in the UI could show honestly. For a skill it means the same flag the
 * skills page and the `/` menu read.
 */
export default memo(function DropdownPlugins({
  children,
  initialMessage = false,
  onOpenChange,
  skills,
  skillsLoading = false,
  onToggleSkill,
}: DropdownPluginsProps) {
  const [isOpen, setIsOpen] = useState(false)
  // Connectors open on arrival — that is the row people came for. Skills stay
  // shut so a long list doesn't bury them.
  const [connectorsOpen, setConnectorsOpen] = useState(true)
  const [skillsOpen, setSkillsOpen] = useState(false)
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

  const goToSkills = () => {
    navigate({ to: route.skills.index })
  }

  // Counts what the model can actually reach: a skill that is switched on but
  // broken or wrong-platform is off as far as the agent is concerned.
  const enabledSkills =
    skills?.filter((skill) => skill.enabled && skill.compatible && !skill.error)
      .length ?? 0

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

  const renderSkillSwitch = (skill: AgentSkill) => {
    // A skill that failed to parse, or that this platform can't run, has
    // nothing to switch on — the skills page is where the reason lives.
    const blocked = Boolean(skill.error) || !skill.compatible
    return (
      <Switch
        aria-label={skill.name}
        checked={skill.enabled && !blocked}
        disabled={blocked || !onToggleSkill}
        onCheckedChange={(checked) => onToggleSkill?.(skill.name, checked)}
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
          {t('common:pluginsMenu.title')}
        </DropDrawerLabel>
        <DropDrawerSeparator />
        <div className="max-h-72 overflow-y-auto">
          <Collapsible open={connectorsOpen} onOpenChange={setConnectorsOpen}>
            <SectionHeader
              label={t('common:connectors')}
              open={connectorsOpen}
              count={activeConnectors}
              onToggle={() => setConnectorsOpen((open) => !open)}
            />
            <CollapsibleContent
              className={cn(collapsiblePanelAnimation, 'pl-3')}
            >
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
                        <ServerIcon
                          connector={entry.connector}
                          name={name}
                          className="size-5 rounded-sm [&>span]:text-[10px]"
                        />
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
              <DropDrawerItem className="py-2" onSelect={goToConnectors}>
                <div className="flex items-center gap-2">
                  <IconSettings size={16} className="text-muted-foreground" />
                  <span className="text-sm">
                    {t('common:connectorsMenu.manage')}
                  </span>
                </div>
              </DropDrawerItem>
            </CollapsibleContent>
          </Collapsible>
          {/* No skills section where skills don't exist at all — the web
              build has no `invoke` to list them with. */}
          {skills && (
            <>
              <DropDrawerSeparator />
              <Collapsible open={skillsOpen} onOpenChange={setSkillsOpen}>
                <SectionHeader
                  label={t('common:skills')}
                  open={skillsOpen}
                  count={enabledSkills}
                  onToggle={() => setSkillsOpen((open) => !open)}
                />
                <CollapsibleContent
                  className={cn(collapsiblePanelAnimation, 'pl-3')}
                >
                  <DropDrawerGroup>
                    {skillsLoading && skills.length === 0 && (
                      <DropDrawerItem disabled>
                        <div className="flex items-center gap-2">
                          <IconLoader2
                            size={16}
                            className="animate-spin text-muted-foreground"
                          />
                          <span className="text-sm">
                            {t('common:agentSkill.loading')}
                          </span>
                        </div>
                      </DropDrawerItem>
                    )}
                    {!skillsLoading && skills.length === 0 && (
                      <DropDrawerItem disabled>
                        {t('common:pluginsMenu.emptySkills')}
                      </DropDrawerItem>
                    )}
                    {skills.map((skill) => (
                      <DropDrawerItem
                        key={skill.name}
                        className="py-2"
                        onSelect={(e) => e.preventDefault()}
                        onClick={(e) => e.preventDefault()}
                        icon={renderSkillSwitch(skill)}
                      >
                        <div className="flex min-w-0 items-center gap-2">
                          <span
                            className="truncate text-sm"
                            title={skill.error ?? skill.description}
                          >
                            {skill.name}
                          </span>
                          {skill.error && (
                            <span className="size-1.5 shrink-0 rounded-full bg-red-500" />
                          )}
                        </div>
                      </DropDrawerItem>
                    ))}
                  </DropDrawerGroup>
                  <DropDrawerItem className="py-2" onSelect={goToSkills}>
                    <div className="flex items-center gap-2">
                      <IconSettings
                        size={16}
                        className="text-muted-foreground"
                      />
                      <span className="text-sm">
                        {t('common:pluginsMenu.manageSkills')}
                      </span>
                    </div>
                  </DropDrawerItem>
                </CollapsibleContent>
              </Collapsible>
            </>
          )}
        </div>
      </DropDrawerContent>
    </DropDrawer>
  )
})
