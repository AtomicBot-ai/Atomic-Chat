import React, { memo, useMemo, useRef, useState } from 'react'
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
import ConnectorToolsDialog, {
  type ConnectorToolsScope,
} from '@/containers/dialogs/ConnectorToolsDialog'
import {
  BROWSER_SERVER_KEYS,
  MCP_CONNECTORS,
  SYSTEM_SERVER_KEYS,
  findInstalledServer,
  type MCPConnector,
} from '@/constants/mcp-connectors'
import { route } from '@/constants/routes'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServerStatuses } from '@/hooks/useMCPServerStatuses'
import { useMCPServerToggle } from '@/hooks/useMCPServerToggle'
import { useMCPServers, type MCPServerConfig } from '@/hooks/useMCPServers'
import { useThreads } from '@/hooks/useThreads'
import { createToolKey, useToolAvailable } from '@/hooks/useToolAvailable'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { formatTokenCount, type ServerToolCost } from '@/lib/tool-cost'
import type { AgentSkill } from '@/services/agent/skills'
import type { MCPTool } from '@/types/completion'

interface DropdownPluginsProps {
  // (isOpen, connectors whose tools ride this chat, connected connectors) -> trigger
  children: (
    isOpen: boolean,
    sentConnectors: number,
    activeConnectors: number
  ) => React.ReactNode
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
 * Every row is a switch over the whole thing: the connector's switch starts
 * or stops its server, a skill's flips the same flag the skills page and the
 * `/` menu read. Single tools, and the per-chat on/off of a connector, live
 * one step deeper — the row's settings button opens `ConnectorToolsDialog`
 * for this chat — and the row reports "k of N tools" so a half-off connector
 * is visible from here.
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
  // Connector whose tools dialog is open. The menu closes first: a dialog
  // over a modal menu fights it for focus and pointer events.
  const [toolsDialogKey, setToolsDialogKey] = useState<string | null>(null)
  // Set on the click that closes the menu for the dialog; read by the menu's
  // unmount focus handler, which runs before state from that click lands.
  const openingToolsDialog = useRef(false)
  const { t } = useTranslation()
  const navigate = useNavigate()

  const allTools = useAppState((state) => state.tools)
  const mcpServers = useMCPServers((state) => state.mcpServers)
  const { statusByName } = useMCPServerStatuses()
  const { toggleServer, isServerPending } = useMCPServerToggle({
    initialMessage,
  })

  // Not listed: the browser server the Browse button owns, and the system
  // servers, which are agent-mode tooling and never ride a chat request.
  const tools = useMemo(
    () =>
      allTools.filter(
        (tool) =>
          !BROWSER_SERVER_KEYS.includes(tool.server) &&
          !SYSTEM_SERVER_KEYS.includes(tool.server)
      ),
    [allTools]
  )

  const { getCurrentThread } = useThreads()
  const currentThread = getCurrentThread()
  const costThreadKey = initialMessage ? '' : (currentThread?.id ?? '')
  // What the tool definitions cost per connector on the last request build
  // (see `CustomChatTransport.refreshTools`); index page reads the '' slot.
  const toolCost = useAppState((state) => state.toolCostReports[costThreadKey])
  const costByServer = useMemo(() => {
    const map = new Map<string, ServerToolCost>()
    for (const entry of toolCost?.perServer ?? []) map.set(entry.server, entry)
    return map
  }, [toolCost])
  // Connectors switched off for this chat only.
  const mutedServers = useToolAvailable((state) =>
    initialMessage
      ? state.defaultMutedServers
      : (state.mutedServers[currentThread?.id ?? ''] ??
        state.defaultMutedServers)
  )
  // Single tools switched off in this scope (see `ConnectorToolsDialog`).
  const disabledToolKeys = useToolAvailable((state) =>
    initialMessage
      ? state.defaultDisabledTools
      : (state.disabledTools[currentThread?.id ?? ''] ??
        state.defaultDisabledTools)
  )
  const disabledTools = useMemo(
    () => new Set(disabledToolKeys),
    [disabledToolKeys]
  )
  const toolsScope: ConnectorToolsScope =
    initialMessage || !currentThread?.id
      ? { kind: 'default' }
      : { kind: 'thread', threadId: currentThread.id }

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
      .filter(
        ([key]) =>
          !BROWSER_SERVER_KEYS.includes(key) &&
          !SYSTEM_SERVER_KEYS.includes(key)
      )
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

  const activeConnectors = entries.filter((entry) => entry.active).length
  // Connectors whose tools actually ride this chat's requests.
  const sentConnectors = entries.filter(
    (entry) => entry.active && !mutedServers.includes(entry.key)
  ).length

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

  const renderTrigger = () => children(isOpen, sentConnectors, activeConnectors)

  /**
   * "N tools · ≈X tokens" for a connector, with the heavy flag as a tooltip.
   * Reads "k of N tools" once single tools are off, so the number of tools
   * the connector has and the number riding this chat are both there.
   */
  const renderCost = (entry: ConnectorEntry, muted: boolean) => {
    if (!entry.active || entry.tools.length === 0) return null
    const cost = costByServer.get(entry.key)
    const share =
      cost?.ctxShare !== undefined ? Math.round(cost.ctxShare * 100) : undefined
    const total = entry.tools.length
    const enabled = entry.tools.filter(
      (tool) => !disabledTools.has(createToolKey(entry.key, tool.name))
    ).length
    const partial = enabled < total
    const label = cost
      ? share !== undefined
        ? t(
            partial
              ? 'common:connectorsMenu.costSharePartial'
              : 'common:connectorsMenu.costShare',
            {
              enabled,
              count: partial ? total : cost.toolCount,
              tokens: formatTokenCount(cost.tokens),
              share,
            }
          )
        : t(
            partial
              ? 'common:connectorsMenu.costPartial'
              : 'common:connectorsMenu.cost',
            {
              enabled,
              count: partial ? total : cost.toolCount,
              tokens: formatTokenCount(cost.tokens),
            }
          )
      : partial
        ? t('common:connectorsMenu.toolCountPartial', {
            enabled,
            count: total,
          })
        : t('common:connectorsMenu.toolCount', { count: total })
    const heavy = Boolean(cost?.heavy) && !muted
    return (
      <span
        className={cn(
          'truncate text-[11px] text-muted-foreground',
          heavy && 'text-amber-600 dark:text-amber-400',
          muted && 'line-through opacity-70'
        )}
        title={
          heavy && share !== undefined && toolCost?.ctxLen
            ? t('common:connectorsMenu.heavy', {
                share,
                ctx: formatTokenCount(toolCost.ctxLen),
              })
            : undefined
        }
        data-testid={`connector-cost-${entry.key}`}
        data-heavy={heavy ? 'true' : undefined}
      >
        {muted ? t('common:connectorsMenu.mutedForChat') : label}
      </span>
    )
  }

  /**
   * Opens the connector's tools for this chat: single tools on/off, and the
   * per-chat switch for the whole connector. Amber while some of it is off,
   * so the row says at a glance that the dialog holds a change.
   */
  const renderToolsButton = (entry: ConnectorEntry, muted: boolean) => {
    if (!entry.active) return null
    const label = t('common:connectorsMenu.configureTools')
    const partial = entry.tools.some((tool) =>
      disabledTools.has(createToolKey(entry.key, tool.name))
    )
    return (
      <button
        type="button"
        className={cn(
          'inline-flex size-6 shrink-0 items-center justify-center rounded-sm text-muted-foreground hover:bg-secondary hover:text-foreground',
          (muted || partial) && 'text-amber-600 dark:text-amber-400'
        )}
        aria-label={label}
        title={label}
        data-testid={`connector-tools-${entry.key}`}
        onClick={(e) => {
          e.preventDefault()
          e.stopPropagation()
          openingToolsDialog.current = true
          handleOpenChange(false)
          setToolsDialogKey(entry.key)
        }}
      >
        <IconSettings size={14} />
      </button>
    )
  }

  const toolsDialogEntry = entries.find((entry) => entry.key === toolsDialogKey)

  return (
    <>
      <DropDrawer open={isOpen} onOpenChange={handleOpenChange}>
        <DropDrawerTrigger asChild>{renderTrigger()}</DropDrawerTrigger>
        <DropDrawerContent
          side="top"
          align="start"
          className="overflow-hidden! min-w-64"
          onClick={(e) => e.stopPropagation()}
          // Closing to open the tools dialog must not hand focus back to the
          // trigger: its tooltip opens on focus and would sit over the dialog.
          onCloseAutoFocus={(e: Event) => {
            if (openingToolsDialog.current) e.preventDefault()
            openingToolsDialog.current = false
          }}
        >
          <DropDrawerLabel className="flex items-center gap-2 sticky -top-1 z-10 px-4 pl-2 py-1">
            {t('common:pluginsMenu.title')}
          </DropDrawerLabel>
          <DropDrawerSeparator />
          {/* Vertical only: WebKit lets a scrollable list be dragged sideways
            on a horizontal swipe even with nothing to scroll to. */}
          <div className="max-h-72 overflow-y-auto overflow-x-hidden overscroll-x-none">
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
                    const muted = mutedServers.includes(entry.key)
                    return (
                      <DropDrawerItem
                        key={entry.key}
                        className="py-2"
                        onSelect={(e) => e.preventDefault()}
                        onClick={(e) => e.preventDefault()}
                        icon={
                          <div className="flex shrink-0 items-center gap-1">
                            {renderToolsButton(entry, muted)}
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
                          <div className="flex min-w-0 flex-col">
                            <span
                              className={cn(
                                'truncate text-sm',
                                muted && 'text-muted-foreground'
                              )}
                              title={isError ? status?.error : undefined}
                            >
                              {name}
                            </span>
                            {renderCost(entry, muted)}
                          </div>
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
      <ConnectorToolsDialog
        open={toolsDialogKey !== null}
        onOpenChange={(open) => {
          if (!open) setToolsDialogKey(null)
        }}
        serverKey={toolsDialogKey ?? ''}
        connector={toolsDialogEntry?.connector}
        scope={toolsScope}
      />
    </>
  )
})
