import { IconCodeCircle, IconPencil, IconTrash } from '@tabler/icons-react'
import { twMerge } from 'tailwind-merge'
import type { MCPConnector } from '@/constants/mcp-connectors'
import type { MCPServerConfig } from '@/hooks/useMCPServers'
import type { MCPServerStatus } from '@/services/mcp/types'
import { Card, CardItem } from '@/containers/Card'
import { ConnectorIcon } from '@/containers/connectors/ConnectorIcon'
import { Button } from '@/components/ui/button'
import { Switch } from '@/components/ui/switch'
import { maskSensitiveUrl } from '@/lib/mask-sensitive-url'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function ConnectedServerCard({
  serverKey,
  config,
  status,
  connector,
  loading,
  onEdit,
  onEditJson,
  onDelete,
  onToggle,
}: {
  serverKey: string
  config: MCPServerConfig
  status?: MCPServerStatus
  /** Catalog entry matching this server, when one exists — drives the icon. */
  connector?: MCPConnector
  loading: boolean
  onEdit: () => void
  onEditJson: () => void
  onDelete: () => void
  onToggle: (active: boolean) => void
}) {
  const { t } = useTranslation()

  return (
    <Card>
      <CardItem
        align="start"
        title={
          <div className="flex items-center gap-x-2">
            {connector && <ConnectorIcon connector={connector} />}
            <div
              title={status?.error}
              aria-label={
                status?.status === 'error'
                  ? `MCP server error: ${status?.error}`
                  : undefined
              }
              className={twMerge(
                'size-2 rounded-full',
                status?.status === 'connected'
                  ? 'bg-green-600 dark:bg-green-600'
                  : status?.status === 'error'
                    ? 'bg-red-600 dark:bg-red-600'
                    : 'bg-secondary'
              )}
            />
            <h1 className="text-foreground text-base capitalize font-studio">
              {serverKey}
            </h1>
            {config.official && (
              <div className="flex items-center gap-1.5 px-2 py-0.5 text-xs bg-secondary border rounded-sm">
                <img
                  src="/images/transparent-logo.png"
                  alt="Atomic Bot"
                  className="w-3 h-3 object-contain"
                />
                <span>Official</span>
              </div>
            )}
          </div>
        }
        descriptionOutside={
          <div className="text-sm text-muted-foreground">
            <div className="mb-1">
              {t('mcp-servers:transport')}:{' '}
              <span className="uppercase">{config.type || 'stdio'}</span>
            </div>
            {status?.status === 'error' && (
              <div
                className="mb-2 text-destructive break-words"
                title={status?.error}
              >
                {status?.error}
              </div>
            )}

            {config.type === 'stdio' || !config.type ? (
              <>
                <div className="break-all">
                  {t('mcp-servers:command')}: {config.command}{' '}
                  {config?.args?.join(' ')}
                </div>
                {config.env && Object.keys(config.env).length > 0 && (
                  <div className="my-1 break-all">
                    {t('mcp-servers:env')}:{' '}
                    {Object.entries(config.env)
                      .map(([key]) => `${key}=******`)
                      .join(', ')}
                  </div>
                )}
              </>
            ) : (
              <>
                <div className="break-all">
                  {t('mcp-servers:url')}: {maskSensitiveUrl(config.url || '')}
                </div>
                {config.headers && Object.keys(config.headers).length > 0 && (
                  <div className="my-1 break-all">
                    {t('mcp-servers:headers')}:{' '}
                    {Object.entries(config.headers)
                      .map(([key]) => `${key}=******`)
                      .join(', ')}
                  </div>
                )}
                {config.timeout && (
                  <div>
                    {t('mcp-servers:timeout')}: {config.timeout}s
                  </div>
                )}
              </>
            )}
          </div>
        }
        actions={
          <div className="flex items-center gap-0.5">
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onEditJson}
              title={t('mcp-servers:editJson.title', { serverName: serverKey })}
            >
              <IconCodeCircle size={18} className="text-muted-foreground" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onEdit}
              title={t('mcp-servers:editServer')}
            >
              <IconPencil size={18} className="text-muted-foreground" />
            </Button>
            <Button
              size="icon-xs"
              variant="ghost"
              onClick={onDelete}
              title={t('mcp-servers:deleteServer.title')}
            >
              <IconTrash size={18} className="text-muted-foreground" />
            </Button>
            <div className="ml-2">
              <Switch
                checked={config.active}
                loading={loading}
                onCheckedChange={onToggle}
              />
            </div>
          </div>
        }
      />
    </Card>
  )
}
