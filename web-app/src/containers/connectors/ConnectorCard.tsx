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
 * One card for every server in the grid, installed or not: a catalog
 * connector renders its brand and description, a hand-added server its
 * command/URL. Every card has the same anatomy — a header row (tile, name and
 * attribution, then the primary action and/or the actions menu at the right
 * edge), the description, and a footer row (status pill, toggle) — so the
 * grid reads as one band of headers and one band of footers. A card that is
 * not set up yet shows Set Up (or Sign in; a disabled Sign in for
 * oauth-soon) in the header and "Not set up" with a disabled toggle in the
 * footer; an installed one shows the menu, its status and a live toggle.
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
          className="w-[88px] justify-center gap-1.5"
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
          className="w-[88px] justify-center gap-1.5"
          onClick={onCancelSignIn}
        >
          <IconLoader2 size={14} className="animate-spin" />
          {t('mcp-connectors:oauth.cancel')}
        </Button>
      ) : (
        <Button
          size="sm"
          className="w-[88px] justify-center gap-1.5"
          onClick={onSetUp}
        >
          {t('mcp-connectors:oauth.signIn')}
        </Button>
      )
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
    ))

  const statusLabel = !installed
    ? t('mcp-connectors:statusNotSetUp')
    : isConnected
      ? t('mcp-connectors:connected')
      : isError
        ? t('mcp-connectors:statusError')
        : t('mcp-connectors:statusInactive')

  return (
    // h-full: the card fills its grid row (the page grid is auto-rows-fr) so
    // footers line up across a row even where the engine (WebKit) is lax
    // about stretching grid items.
    <Card className="bg-card rounded-lg p-4 text-muted-foreground flex h-full flex-col gap-3">
      <div className="flex items-center gap-3">
        <ServerIcon connector={connector} name={name} className="size-10" />
        <div className="min-w-0 flex-1">
          <div className="flex items-center gap-2">
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
            <p className="text-xs text-muted-foreground">
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
        {/* Right edge of the header: the action first, then the menu. */}
        <div className="flex shrink-0 items-center gap-1">
          {action}
          {installed && (
            <DropdownMenu>
              <DropdownMenuTrigger asChild>
                <Button
                  size="icon-xs"
                  variant="ghost"
                  title={t('mcp-connectors:serverActions')}
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
        </div>
      </div>
      <p className="text-sm leading-normal text-muted-foreground flex-1">
        {connector ? t(connector.descriptionKey) : ''}
      </p>
      {/* The same footer on every card, min-h-8 so the band keeps one height:
          the status pill on the left, the toggle on the right (disabled until
          the connector is set up). */}
      <div className="flex min-h-8 items-center justify-between gap-2">
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
          aria-label={
            isError ? `MCP server error: ${status?.error}` : undefined
          }
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
          {statusLabel}
        </span>
        <Switch
          checked={isActive}
          disabled={!installed}
          loading={busy && Boolean(installed)}
          onCheckedChange={onToggle}
        />
      </div>
    </Card>
  )
}
