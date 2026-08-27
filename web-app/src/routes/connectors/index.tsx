import { createFileRoute } from '@tanstack/react-router'
import { Fragment, useEffect, useMemo, useState } from 'react'
import { toast } from 'sonner'
import { IconCodeCircle, IconPlus } from '@tabler/icons-react'
import { route } from '@/constants/routes'
import {
  HIDDEN_SERVER_KEYS,
  MCP_CONNECTORS,
  buildConnectorConfig,
  findInstalledServer,
  type MCPConnector,
} from '@/constants/mcp-connectors'
import HeaderPage from '@/containers/HeaderPage'
import { Card, CardItem } from '@/containers/Card'
import { ConnectorCard } from '@/containers/connectors/ConnectorCard'
import { ConnectedServerCard } from '@/containers/connectors/ConnectedServerCard'
import AddEditMCPServer from '@/containers/dialogs/AddEditMCPServer'
import ConnectorSecretDialog from '@/containers/dialogs/ConnectorSecretDialog'
import DeleteMCPServerConfirm from '@/containers/dialogs/DeleteMCPServerConfirm'
import EditJsonMCPserver from '@/containers/dialogs/EditJsonMCPserver'
import { UnplugIcon } from '@/components/animated-icon/unplug'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import {
  DEFAULT_MCP_SETTINGS,
  useMCPServers,
  type MCPServerConfig,
  type MCPSettings,
} from '@/hooks/useMCPServers'
import { useMCPServerStatuses } from '@/hooks/useMCPServerStatuses'
import { useAppState } from '@/hooks/useAppState'
import { useGeneralSetting } from '@/hooks/useGeneralSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useToolApproval } from '@/hooks/useToolApproval'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { MCPLogViewer } from '@/components/MCPLogViewer'
import { cn } from '@/lib/utils'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.connectors.index as any)({
  component: ConnectorsPage,
})

function ConnectorsPage() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const {
    mcpServers,
    settings,
    addServer,
    editServer,
    renameServer,
    deleteServer,
    syncServers,
    syncServersAndRestart,
    getServerConfig,
    setSettings,
    updateSettings,
  } = useMCPServers()
  const { allowAllMCPPermissions, setAllowAllMCPPermissions } =
    useToolApproval()
  const { statusByName, refresh } = useMCPServerStatuses()
  const setErrorMessage = useAppState((state) => state.setErrorMessage)

  const [activeTab, setActiveTab] = useState<'connectors' | 'logs'>(
    'connectors'
  )
  const [selectedLogServer, setSelectedLogServer] = useState<
    string | undefined
  >(undefined)

  // Add/edit dialog state
  const [dialogOpen, setDialogOpen] = useState(false)
  const [editingKey, setEditingKey] = useState<string | null>(null)
  const [currentConfig, setCurrentConfig] = useState<
    MCPServerConfig | undefined
  >(undefined)

  // Delete confirmation dialog state
  const [deleteDialogOpen, setDeleteDialogOpen] = useState(false)
  const [serverToDelete, setServerToDelete] = useState<string | null>(null)

  // JSON editor dialog state
  const [jsonEditorOpen, setJsonEditorOpen] = useState(false)
  const [jsonServerName, setJsonServerName] = useState<string | null>(null)
  const [jsonEditorData, setJsonEditorData] = useState<
    | MCPServerConfig
    | Record<string, MCPServerConfig>
    | {
        mcpServers: Record<string, MCPServerConfig>
        mcpSettings?: MCPSettings
      }
    | undefined
  >(undefined)

  // Secret dialog state (catalog connectors that need an API key)
  const [secretConnector, setSecretConnector] = useState<MCPConnector | null>(
    null
  )

  const [busyServers, setBusyServers] = useState<{ [key: string]: boolean }>(
    {}
  )
  const setBusy = (key: string, busy: boolean) =>
    setBusyServers((prev) => ({ ...prev, [key]: busy }))

  // First visit clears the sidebar "New" pill on Connectors.
  useEffect(() => {
    useGeneralSetting.getState().markConnectorsBadgeSeen()
  }, [])

  const visibleServerEntries = useMemo(
    () =>
      Object.entries(mcpServers).filter(
        ([key]) => !HIDDEN_SERVER_KEYS.includes(key)
      ),
    [mcpServers]
  )

  // Which user server (if any) each catalog connector maps to, and back.
  const installedByConnector = useMemo(() => {
    const map = new Map<
      string,
      { key: string; config: MCPServerConfig } | undefined
    >()
    for (const connector of MCP_CONNECTORS) {
      map.set(connector.serverKey, findInstalledServer(connector, mcpServers))
    }
    return map
  }, [mcpServers])

  const connectorByServerKey = useMemo(() => {
    const map = new Map<string, MCPConnector>()
    for (const connector of MCP_CONNECTORS) {
      const hit = installedByConnector.get(connector.serverKey)
      if (hit) map.set(hit.key, connector)
    }
    return map
  }, [installedByConnector])

  const updateToolCallTimeout = (rawValue: string) => {
    if (rawValue === '') {
      updateSettings({
        toolCallTimeoutSeconds: DEFAULT_MCP_SETTINGS.toolCallTimeoutSeconds,
      })
      return
    }

    const numericValue = Number(rawValue)
    if (!Number.isNaN(numericValue)) {
      updateSettings({ toolCallTimeoutSeconds: numericValue })
    }
  }

  const toggleServer = (serverKey: string, active: boolean) => {
    if (!serverKey) return
    setBusy(serverKey, true)
    const config = getServerConfig(serverKey)
    if (active && config) {
      serviceHub
        .mcp()
        .activateMCPServer(serverKey, { ...config, active })
        .then(() => {
          editServer(serverKey, { ...config, active })
          syncServers()
          toast.success(t('mcp-servers:serverStatusActive', { serverKey }))
          refresh()
        })
        .catch((error) => {
          editServer(serverKey, { ...config, active: false })
          setErrorMessage({
            message: error,
            subtitle: t('mcp-servers:checkParams'),
          })
        })
        .finally(() => {
          setBusy(serverKey, false)
        })
    } else {
      editServer(serverKey, {
        ...(config ?? (mcpServers[serverKey] as MCPServerConfig)),
        active,
      })
      syncServers()
      serviceHub
        .mcp()
        .deactivateMCPServer(serverKey)
        .finally(() => {
          refresh()
          setBusy(serverKey, false)
        })
    }
  }

  // One-click install: add deactivated, then activate, then persist — a
  // failed spawn must never leave `active: true` on disk.
  const install = async (
    connector: MCPConnector,
    secretValue?: string
  ): Promise<boolean> => {
    const key = connector.serverKey
    setBusy(key, true)
    let config: MCPServerConfig | undefined
    try {
      config = await buildConnectorConfig(connector, secretValue)
      addServer(key, { ...config, active: false })
      await serviceHub.mcp().activateMCPServer(key, { ...config, active: true })
      editServer(key, { ...config, active: true })
      await syncServers()
      toast.success(
        t('mcp-connectors:toast.connected', { name: connector.name })
      )
      refresh()
      return true
    } catch (error) {
      if (config) {
        editServer(key, { ...config, active: false })
        await syncServers()
      }
      setErrorMessage({
        message: error instanceof Error ? error.message : String(error),
        subtitle: t('mcp-servers:checkParams'),
      })
      return false
    } finally {
      setBusy(key, false)
    }
  }

  const handleSetUp = (connector: MCPConnector) => {
    if (connector.secret) {
      setSecretConnector(connector)
    } else {
      void install(connector)
    }
  }

  const handleSecretConnect = async (value: string) => {
    if (!secretConnector) return
    const ok = await install(secretConnector, value)
    // Keep the dialog open on failure so the user can fix the key and retry.
    if (ok) setSecretConnector(null)
  }

  const handleOpenDialog = (serverKey?: string) => {
    if (serverKey) {
      setCurrentConfig(mcpServers[serverKey])
      setEditingKey(serverKey)
    } else {
      setCurrentConfig(undefined)
      setEditingKey(null)
    }
    setDialogOpen(true)
  }

  const handleSaveServer = async (name: string, config: MCPServerConfig) => {
    if (editingKey) {
      // If server name changed, rename it while preserving position
      if (editingKey !== name) {
        toggleServer(editingKey, false)
        renameServer(editingKey, name, config)
        toggleServer(name, true)
        // Restart servers to update tool references with new server name
        syncServersAndRestart()
      } else {
        toggleServer(editingKey, false)
        editServer(editingKey, config)
        toggleServer(editingKey, true)
        syncServers()
      }
    } else {
      toggleServer(name, false)
      addServer(name, config)
      toggleServer(name, true)
      syncServers()
    }
  }

  const handleConfirmDelete = async () => {
    if (serverToDelete) {
      // Stop the server before deletion
      try {
        await serviceHub.mcp().deactivateMCPServer(serverToDelete)
      } catch (error) {
        console.error('Error stopping server before deletion:', error)
      }

      deleteServer(serverToDelete)
      toast.success(
        t('mcp-servers:deleteServer.success', { serverName: serverToDelete })
      )
      setServerToDelete(null)
      syncServersAndRestart()
    }
  }

  const handleOpenJsonEditor = (serverKey?: string) => {
    if (serverKey) {
      setJsonServerName(serverKey)
      setJsonEditorData(mcpServers[serverKey])
    } else {
      setJsonServerName(null)
      setJsonEditorData({
        mcpServers,
        mcpSettings: settings,
      })
    }
    setJsonEditorOpen(true)
  }

  const handleSaveJson = async (
    data:
      | MCPServerConfig
      | Record<string, MCPServerConfig>
      | {
          mcpServers?: Record<string, MCPServerConfig>
          mcpSettings?: MCPSettings
        }
  ) => {
    if (jsonServerName) {
      try {
        toggleServer(jsonServerName, false)
      } catch (error) {
        console.error('Error deactivating server:', error)
      }
      editServer(jsonServerName, data as MCPServerConfig)
      toggleServer(jsonServerName, (data as MCPServerConfig).active || false)
    } else {
      let nextServers: Record<string, MCPServerConfig> = {}
      let nextSettings: MCPSettings | undefined

      if (data && typeof data === 'object' && !Array.isArray(data)) {
        if ('mcpServers' in data || 'mcpSettings' in data) {
          const payload = data as {
            mcpServers?: Record<string, MCPServerConfig>
            mcpSettings?: MCPSettings
          }
          nextServers = payload.mcpServers ?? {}
          nextSettings = payload.mcpSettings
        } else {
          nextServers = data as Record<string, MCPServerConfig>
        }
      }

      if (nextSettings) {
        setSettings({
          toolCallTimeoutSeconds:
            typeof nextSettings.toolCallTimeoutSeconds === 'number'
              ? nextSettings.toolCallTimeoutSeconds
              : DEFAULT_MCP_SETTINGS.toolCallTimeoutSeconds,
        })
      }

      // Clear existing servers first
      Object.keys(mcpServers).forEach((serverKey) => {
        toggleServer(serverKey, false)
        deleteServer(serverKey)
      })

      // Add all servers from the JSON
      Object.entries(nextServers).forEach(([key, config]) => {
        addServer(key, config)
        toggleServer(key, config.active || false)
      })

      await syncServers()
    }
  }

  return (
    <Fragment>
      <div className="flex h-svh w-full flex-col">
        <HeaderPage>
          <span className="font-medium text-base font-studio">
            {t('mcp-connectors:title')}
          </span>
        </HeaderPage>
        <div className="h-[calc(100%-60px)] overflow-y-auto p-4 pt-0">
          <div className="mx-auto flex max-w-3xl flex-col gap-6">
            <div className="flex gap-1 p-1 bg-secondary/50 rounded-lg mt-4 sticky top-0 z-10">
              <button
                type="button"
                onClick={() => setActiveTab('connectors')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors flex-1 justify-center',
                  activeTab === 'connectors'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('mcp-connectors:tabs.connectors')}
              </button>
              <button
                type="button"
                onClick={() => setActiveTab('logs')}
                className={cn(
                  'flex items-center gap-2 px-3 py-2 rounded-md text-sm font-medium transition-colors flex-1 justify-center',
                  activeTab === 'logs'
                    ? 'bg-background text-foreground shadow-sm'
                    : 'text-muted-foreground hover:text-foreground'
                )}
              >
                {t('mcp-connectors:tabs.logs')}
              </button>
            </div>

            {activeTab === 'connectors' && (
              <>
                <section className="flex flex-col gap-3">
                  <div>
                    <h1 className="font-studio text-lg font-medium text-foreground">
                      {t('mcp-connectors:connectedSection')}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {t('mcp-connectors:connectedSectionDesc')}
                    </p>
                  </div>
                  {visibleServerEntries.length === 0 ? (
                    <Card className="bg-card rounded-lg border border-dashed border-border p-6">
                      <div className="flex flex-col items-center gap-2 text-center">
                        <UnplugIcon
                          className="text-muted-foreground"
                          size={24}
                        />
                        <span className="font-medium text-foreground">
                          {t('mcp-connectors:emptyState.title')}
                        </span>
                        <span className="text-sm text-muted-foreground">
                          {t('mcp-connectors:emptyState.desc')}
                        </span>
                      </div>
                    </Card>
                  ) : (
                    visibleServerEntries.map(([key, config]) => (
                      <ConnectedServerCard
                        key={key}
                        serverKey={key}
                        config={config}
                        status={statusByName.get(key)}
                        connector={connectorByServerKey.get(key)}
                        loading={!!busyServers[key]}
                        onEdit={() => handleOpenDialog(key)}
                        onEditJson={() => handleOpenJsonEditor(key)}
                        onDelete={() => {
                          setServerToDelete(key)
                          setDeleteDialogOpen(true)
                        }}
                        onToggle={(checked) => toggleServer(key, checked)}
                      />
                    ))
                  )}
                </section>

                <section className="flex flex-col gap-3">
                  <div>
                    <h1 className="font-studio text-lg font-medium text-foreground">
                      {t('mcp-connectors:popularSection')}
                    </h1>
                    <p className="text-sm text-muted-foreground">
                      {t('mcp-connectors:popularSectionDesc')}
                    </p>
                  </div>
                  <div className="grid grid-cols-1 gap-3 sm:grid-cols-2">
                    {MCP_CONNECTORS.map((connector) => {
                      const installed = installedByConnector.get(
                        connector.serverKey
                      )
                      return (
                        <ConnectorCard
                          key={connector.serverKey}
                          connector={connector}
                          installed={installed}
                          status={
                            installed
                              ? statusByName.get(installed.key)
                              : undefined
                          }
                          busy={!!busyServers[connector.serverKey]}
                          onSetUp={() => handleSetUp(connector)}
                          onEnable={() =>
                            installed && toggleServer(installed.key, true)
                          }
                        />
                      )
                    })}
                  </div>
                </section>

                <section className="flex flex-col gap-3">
                  <Card>
                    <CardItem
                      title={t('mcp-connectors:manualSection')}
                      description={
                        <>
                          {t('mcp-connectors:manualSectionDesc')}{' '}
                          {t('mcp-connectors:findMore')}{' '}
                          <a
                            href="https://mcp.so/"
                            target="_blank"
                            rel="noopener noreferrer"
                            className="text-primary hover:underline"
                          >
                            mcp.so
                          </a>
                        </>
                      }
                      actions={
                        <Button
                          variant="outline"
                          size="sm"
                          onClick={() => handleOpenDialog()}
                        >
                          <IconPlus
                            size={18}
                            className="text-muted-foreground"
                          />
                          {t('mcp-connectors:addCustom')}
                        </Button>
                      }
                    />
                  </Card>
                </section>

                <section className="flex flex-col gap-3">
                  <Card
                    header={
                      <div className="flex items-center justify-between mb-4">
                        <h1 className="text-foreground font-medium text-base font-studio">
                          {t('mcp-connectors:advancedSection')}
                        </h1>
                        <Button
                          onClick={() => handleOpenJsonEditor()}
                          title={t('mcp-servers:editAllJson')}
                          size="icon-xs"
                          variant="ghost"
                        >
                          <IconCodeCircle
                            size={18}
                            className="text-muted-foreground"
                          />
                        </Button>
                      </div>
                    }
                  >
                    <CardItem
                      title={t('mcp-servers:allowPermissions')}
                      description={t('mcp-servers:allowPermissionsDesc')}
                      actions={
                        <div className="shrink-0 ml-4">
                          <Switch
                            checked={allowAllMCPPermissions}
                            onCheckedChange={setAllowAllMCPPermissions}
                          />
                        </div>
                      }
                    />
                    <CardItem
                      title={t('mcp-servers:runtimeSettings.toolCallTimeout')}
                      description={t(
                        'mcp-servers:runtimeSettings.toolCallTimeoutDesc'
                      )}
                      actions={
                        <Input
                          type="number"
                          min={1}
                          step={1}
                          value={settings.toolCallTimeoutSeconds}
                          onChange={(event) =>
                            updateToolCallTimeout(event.target.value)
                          }
                          onBlur={() => {
                            void syncServers()
                          }}
                          className="w-28"
                        />
                      }
                    />
                  </Card>
                </section>
              </>
            )}

            {activeTab === 'logs' && (
              <div className="flex flex-col gap-3 w-full">
                <Card>
                  <CardItem
                    title={t('mcp-servers:logs.serverFilterLabel')}
                    actions={
                      <select
                        value={selectedLogServer ?? ''}
                        onChange={(event) =>
                          setSelectedLogServer(
                            event.target.value === ''
                              ? undefined
                              : event.target.value
                          )
                        }
                        className="h-9 rounded-md border border-input bg-background px-2 text-sm shadow-sm focus:outline-none focus:ring-1 focus:ring-ring"
                      >
                        <option value="">
                          {t('mcp-servers:logs.allServers')}
                        </option>
                        {visibleServerEntries.map(([key]) => (
                          <option key={key} value={key}>
                            {key}
                          </option>
                        ))}
                      </select>
                    }
                  />
                </Card>
                <div className="min-h-[400px] flex-1">
                  <MCPLogViewer serverName={selectedLogServer} />
                </div>
              </div>
            )}
          </div>
        </div>
      </div>

      <AddEditMCPServer
        open={dialogOpen}
        onOpenChange={setDialogOpen}
        editingKey={editingKey}
        initialData={currentConfig}
        onSave={handleSaveServer}
      />

      <ConnectorSecretDialog
        open={secretConnector !== null}
        onOpenChange={(open) => {
          if (!open) setSecretConnector(null)
        }}
        connector={secretConnector}
        busy={!!secretConnector && !!busyServers[secretConnector.serverKey]}
        onConnect={handleSecretConnect}
      />

      <DeleteMCPServerConfirm
        open={deleteDialogOpen}
        onOpenChange={setDeleteDialogOpen}
        serverName={serverToDelete || ''}
        onConfirm={handleConfirmDelete}
      />

      <EditJsonMCPserver
        open={jsonEditorOpen}
        onOpenChange={setJsonEditorOpen}
        serverName={jsonServerName}
        initialData={
          jsonEditorData ?? {
            mcpServers,
            mcpSettings: settings,
          }
        }
        onSave={handleSaveJson}
      />
    </Fragment>
  )
}
