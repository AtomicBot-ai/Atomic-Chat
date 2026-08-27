import { IconLoader2 } from '@tabler/icons-react'
import type { MCPConnector } from '@/constants/mcp-connectors'
import type { MCPServerConfig } from '@/hooks/useMCPServers'
import type { MCPServerStatus } from '@/services/mcp/types'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import { ConnectorIcon } from '@/containers/connectors/ConnectorIcon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

export function ConnectorCard({
  connector,
  installed,
  status,
  busy,
  onSetUp,
  onEnable,
}: {
  connector: MCPConnector
  installed?: { key: string; config: MCPServerConfig }
  status?: MCPServerStatus
  busy: boolean
  onSetUp: () => void
  onEnable: () => void
}) {
  const { t } = useTranslation()

  const isActive = installed?.config.active
  const isError = isActive && status?.status === 'error'
  const isConnected = isActive && status?.status === 'connected'

  return (
    <Card className="bg-card rounded-lg p-4 text-muted-foreground flex flex-col gap-3">
      <div className="flex items-start gap-3">
        <ConnectorIcon connector={connector} />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
            <h2 className="font-studio truncate text-base font-medium text-foreground">
              {connector.name}
            </h2>
            {connector.featured && (
              <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
                {t('mcp-connectors:featuredBadge')}
              </span>
            )}
          </div>
          <p className="text-xs text-muted-foreground">
            {t('mcp-connectors:by', { name: connector.author })}
          </p>
        </div>
      </div>
      <p className="text-sm leading-normal text-muted-foreground flex-1">
        {t(connector.descriptionKey)}
      </p>
      <div className="flex items-center justify-end gap-2">
        {installed ? (
          <>
            <span
              className={cn(
                'flex items-center gap-1.5 rounded-full px-2 py-0.5 text-xs font-medium',
                isConnected
                  ? 'bg-emerald-500/10 text-emerald-600'
                  : isError
                    ? 'bg-red-500/10 text-red-600'
                    : 'bg-muted text-muted-foreground'
              )}
              title={isError ? status?.error : undefined}
            >
              <span
                className={cn(
                  'size-2 rounded-full',
                  isConnected
                    ? 'bg-green-600'
                    : isError
                      ? 'bg-red-600'
                      : 'bg-muted-foreground/40'
                )}
              />
              {isConnected || isError
                ? t('mcp-connectors:connected')
                : t('mcp-connectors:added')}
            </span>
            {!isActive && (
              <Button
                variant="secondary"
                size="sm"
                className="w-[88px] justify-center gap-1.5"
                onClick={onEnable}
                disabled={busy}
              >
                {busy && <IconLoader2 size={14} className="animate-spin" />}
                {t('mcp-connectors:enable')}
              </Button>
            )}
          </>
        ) : (
          <Button
            size="sm"
            className="w-[88px] justify-center gap-1.5"
            onClick={onSetUp}
            disabled={busy}
          >
            {busy && <IconLoader2 size={14} className="animate-spin" />}
            {t('mcp-connectors:setUp')}
          </Button>
        )}
      </div>
    </Card>
  )
}
