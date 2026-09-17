import {
  IconCodeCircle,
  IconDotsVertical,
  IconLoader2,
  IconPencil,
  IconTool,
  IconTrash,
} from '@tabler/icons-react'
import type { MCPConnector } from '@/constants/mcp-connectors'
import type { MCPServerConfig } from '@/hooks/useMCPServers'
import type { MCPServerStatus } from '@/services/mcp/types'
import { Card } from '@/containers/Card'
import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuSeparator,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Switch } from '@/components/ui/switch'
import { ServerIcon } from '@/containers/connectors/ServerIcon'
import { maskSensitiveUrl } from '@/lib/mask-sensitive-url'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * Catalog cards offer setup until a configuration exists. Configured cards
 * put their menu and toggle together, with status below the identity. Reserve
 * that status line and the description area so state changes keep the grid stable.
 */
export function ConnectorCard({
  connector,
  installed,
  status,
  busy,
  onSetUp,
  onCancelSignIn,
  onToggle,
  onEdit,
  onEditJson,
  onTools,
  onDelete,
}: {
  /** Catalog entry, when one exists — drives icon, name and description. */
  connector?: MCPConnector
  /** The user's server entry, when this card is installed. */
  installed?: { key: string; config: MCPServerConfig }
  status?: MCPServerStatus
  busy: boolean
  onSetUp?: () => void
  /** Abandons a browser sign-in that is still pending. */
  onCancelSignIn?: () => void
  onToggle?: (active: boolean) => void
  onEdit?: () => void
  onEditJson?: () => void
  /** Opens the per-tool switches for this server. */
  onTools?: () => void
  onDelete?: () => void
}) {
  const { t } = useTranslation()

  const config = installed?.config
  const isActive = Boolean(config?.active)
  const isError = isActive && status?.status === 'error'
  const isConnected = isActive && status?.status === 'connected'

  const isRemote = config?.type === 'http' || config?.type === 'sse'
  const summary = config
    ? isRemote
      ? maskSensitiveUrl(config.url || '')
      : [config.command, ...(config.args ?? [])].join(' ').trim()
    : ''

  const name = connector?.name ?? installed?.key ?? ''

  // The primary action of a card that is not set up yet. It sits in the
  // header, where an installed card keeps its menu.
  const action =
    !installed &&
    (connector?.auth === 'oauth-soon' ? (
      // The provider does not accept our automatic registration yet —
      // an honest disabled button beats a flow that always fails.
      <span title={t('mcp-connectors:oauth.comingSoon')}>
        <Button
          size="sm"
          variant="secondary"
          className="min-w-[88px] justify-center gap-1.5"
          disabled
        >
          {t('mcp-connectors:oauth.signIn')}
        </Button>
      </span>
    ) : connector?.auth === 'oauth' ? (
      busy ? (
        // The sign-in is waiting on the browser; the button becomes the
        // way out.
        <Button
          size="sm"
          variant="secondary"
          className="min-w-[88px] justify-center gap-1.5"
          onClick={onCancelSignIn}
        >
          <IconLoader2 size={14} className="animate-spin" />
          {t('mcp-connectors:oauth.cancel')}
        </Button>
      ) : (
        <Button
          size="sm"
          className="min-w-[88px] justify-center gap-1.5"
          onClick={onSetUp}
        >
          {t('mcp-connectors:oauth.signIn')}
        </Button>
      )
    ) : (
      <Button
        size="sm"
        className="min-w-[88px] justify-center gap-1.5"
        onClick={onSetUp}
        disabled={busy}
      >
        {busy && <IconLoader2 size={14} className="animate-spin" />}
        {t('mcp-connectors:setUp')}
      </Button>
    ))

  const statusLabel = isConnected
    ? t('mcp-connectors:connected')
    : isError
      ? t('mcp-connectors:statusError')
      : t('mcp-connectors:statusInactive')

  return (
    // The page grid uses auto-rows-fr; fill it even in the desktop webview.
    <Card className="bg-card rounded-lg p-4 text-muted-foreground flex h-full flex-col gap-3">
      <div className="grid min-w-0 grid-cols-[40px_minmax(0,1fr)_auto] items-center gap-x-3">
        <ServerIcon connector={connector} name={name} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex min-w-0 items-center gap-2">
            <h2
              className={cn(
                'font-studio truncate text-base font-medium text-foreground',
                !connector && 'capitalize'
              )}
            >
              {name}
            </h2>
            {connector?.featured && (
              <span className="shrink-0 rounded-full bg-blue-500/15 px-1.5 py-0.5 text-[10px] font-semibold uppercase tracking-wide text-blue-600 dark:bg-blue-400/15 dark:text-blue-400">
                {t('mcp-connectors:featuredBadge')}
              </span>
            )}
            {config?.official && (
              <div className="flex shrink-0 items-center gap-1.5 px-2 py-0.5 text-xs bg-secondary border rounded-sm">
                <img
                  src="/images/transparent-logo.png"
                  alt="Atomic Bot"
                  className="w-3 h-3 object-contain"
                />
                <span>Official</span>
              </div>
            )}
          </div>
          {connector ? (
            <p className="truncate text-xs text-muted-foreground">
              {t('mcp-connectors:by', { name: connector.author })}
            </p>
          ) : (
            <p
              className="truncate text-xs text-muted-foreground"
              title={summary}
            >
              {summary}
            </p>
          )}
        </div>
        {/* Configured controls share one stable slot at the right edge. */}
        <div className="flex shrink-0 items-center gap-3">
          {action}
          {installed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title={t('mcp-connectors:serverActions')}
                  aria-label={t('mcp-connectors:serverActions')}
                >
                  <IconDotsVertical
                    size={18}
                    className="text-muted-foreground"
                  />
                </Button>
              </DropdownMenuTrigger>
              <DropdownMenuContent align="end">
                <DropdownMenuItem onSelect={onEdit}>
                  <IconPencil size={16} />
                  {t('mcp-servers:editServer')}
                </DropdownMenuItem>
                <DropdownMenuItem onSelect={onEditJson}>
                  <IconCodeCircle size={16} />
                  {t('mcp-connectors:editJson')}
                </DropdownMenuItem>
                {onTools && (
                  <DropdownMenuItem onSelect={onTools}>
                    <IconTool size={16} />
                    {t('mcp-connectors:tools')}
                  </DropdownMenuItem>
                )}
                <DropdownMenuSeparator />
                <DropdownMenuItem variant="destructive" onSelect={onDelete}>
                  <IconTrash size={16} />
                  {t('mcp-servers:deleteServer.title')}
                </DropdownMenuItem>
              </DropdownMenuContent>
            </DropdownMenu>
          )}
          {installed && (
            <Switch
              className="w-8.5 [&>div]:overflow-hidden [&_svg]:size-3.5"
              aria-label={t('mcp-connectors:enableConnector', { name })}
              checked={isActive}
              disabled={busy}
              loading={busy}
              onCheckedChange={onToggle}
            />
          )}
        </div>
        <div className="col-start-2 min-w-0 h-[1.5em] text-xs leading-normal">
          {installed && (
            <span
              className={cn(
                'block truncate',
                isConnected
                  ? 'text-emerald-600 dark:text-emerald-400'
                  : isError
                    ? 'text-red-600 dark:text-red-400'
                    : 'text-muted-foreground'
              )}
              title={isError ? status?.error : undefined}
              aria-label={
                isError ? `MCP server error: ${status?.error}` : undefined
              }
            >
              {statusLabel}
            </span>
          )}
        </div>
      </div>
      <p
        className="h-[4.5em] shrink-0 line-clamp-3 text-sm leading-normal text-muted-foreground"
        title={connector ? t(connector.descriptionKey) : undefined}
      >
        {connector ? t(connector.descriptionKey) : ''}
      </p>
    </Card>
  )
}
