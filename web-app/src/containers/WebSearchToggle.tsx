import { memo, useMemo, useState } from 'react'
import { IconLoader2, IconWorld } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipProvider,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useThreads } from '@/hooks/useThreads'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import {
  connectorBlock,
  useComposerSecureEnvironment,
} from '@/hooks/useSecureEnvironments'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  findWebSearchServer,
  hasWebSearchTool,
  isWebSearchEnabled,
} from '@/lib/web-search'
import { trackMcpActivation } from '@/lib/mcp-activation'
import { cn } from '@/lib/utils'

type WebSearchToggleProps = {
  className?: string
  // The index page edits the defaults for new threads instead of a thread.
  initialMessage?: boolean
  // A project page's composer: that project's secure policy applies.
  projectId?: string
}

const WebSearchToggle = memo(function WebSearchToggle({
  className,
  initialMessage = false,
  projectId,
}: WebSearchToggleProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const [pending, setPending] = useState(false)
  const [failed, setFailed] = useState(false)
  const tools = useAppState((state) => state.tools)

  const mcpServers = useMCPServers((state) => state.mcpServers)
  const editServer = useMCPServers((state) => state.editServer)
  const syncServers = useMCPServers((state) => state.syncServers)

  const { getCurrentThread } = useThreads()
  const {
    getDefaultDisabledTools,
    setDefaultDisabledTools,
    getDisabledToolsForThread,
    setToolDisabledForThread,
    getMutedServersForThread,
    getDefaultMutedServers,
    setServerMutedForThread,
    setDefaultServerMuted,
  } = useToolAvailable()

  const server = useMemo(() => findWebSearchServer(mcpServers), [mcpServers])
  const secure = useComposerSecureEnvironment(initialMessage, projectId)
  // A secure project that keeps web search out of its chats: the globe shows
  // off and cannot be switched (the chat would not send its tools anyway).
  const block = server ? connectorBlock(secure, server.key, true) : null
  const threadId = initialMessage ? undefined : getCurrentThread()?.id
  const disabledTools = threadId
    ? getDisabledToolsForThread(threadId)
    : getDefaultDisabledTools()
  const mutedServers = threadId
    ? getMutedServersForThread(threadId)
    : getDefaultMutedServers()
  const enabled =
    !block && isWebSearchEnabled(server, tools, disabledTools, mutedServers)
  const unavailable =
    (failed && !enabled) ||
    Boolean(server?.config.active && !hasWebSearchTool(server, tools))
  const label = pending
    ? t('common:webSearchToggleConnecting')
    : unavailable
      ? t('common:webSearchToggleUnavailable')
      : enabled
        ? t('common:webSearchToggleEnabled')
        : t('common:webSearchToggleDisabled')

  if (!server) return null

  // Turning the globe on has to clear any per-tool switches the tools dropdown
  // left behind, otherwise the server comes up but its tools stay muted.
  const enableServerTools = (serverKey: string) => {
    const prefix = `${serverKey}::`
    if (threadId) {
      setServerMutedForThread(threadId, serverKey, false)
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
    setDefaultServerMuted(serverKey, false)
    setDefaultDisabledTools(
      getDefaultDisabledTools().filter((key) => !key.startsWith(prefix))
    )
  }

  const handleClick = async () => {
    if (pending) return
    const { key, config } = server
    setPending(true)
    setFailed(false)
    try {
      if (enabled) {
        editServer(key, { ...config, active: false })
        await syncServers()
        await serviceHub.mcp().deactivateMCPServer(key)
      } else {
        // A message sent while this runs waits for it, up to the point where
        // the transport sees the server active, its tools and no mute.
        const activation = (async () => {
          if (!config.active || !hasWebSearchTool(server, tools)) {
            await serviceHub
              .mcp()
              .activateMCPServer(key, { ...config, active: true })
            const snapshot = await serviceHub.mcp().getToolsWithStatus()
            useAppState.getState().updateTools(snapshot.tools)
            useAppState
              .getState()
              .updateMcpToolNames(snapshot.tools.map((tool) => tool.name))
            if (!hasWebSearchTool(server, snapshot.tools)) {
              throw new Error(t('common:webSearchToggleUnavailable'))
            }
          }
          editServer(key, { ...config, active: true })
          enableServerTools(key)
        })()
        trackMcpActivation(key, activation)
        await activation
        await syncServers()
      }
    } catch {
      // The activation failed, so leave the stored config off to match reality.
      editServer(key, { ...config, active: false })
      setFailed(true)
      toast.error(t('common:webSearchTemporarilyUnavailable'))
    } finally {
      setPending(false)
    }
  }

  if (block) {
    return (
      <TooltipProvider>
        <Tooltip>
          {/* A disabled button gets no pointer events, so the span carries
              the tooltip. */}
          <TooltipTrigger asChild>
            <span tabIndex={0} className="inline-flex">
              <Button
                variant="ghost"
                size="icon-xs"
                className={className}
                disabled
                aria-label={t('common:webSearchToggleDisabled')}
                aria-pressed={false}
              >
                <IconWorld size={18} className="text-muted-foreground" />
              </Button>
            </span>
          </TooltipTrigger>
          <TooltipContent>
            <p>
              {t(
                block === 'network'
                  ? 'common:secureEnvironmentBlock.webSearchOffline'
                  : 'common:secureEnvironmentBlock.notAllowed'
              )}
            </p>
          </TooltipContent>
        </Tooltip>
      </TooltipProvider>
    )
  }

  return (
    <TooltipProvider>
      <Tooltip>
        <TooltipTrigger asChild>
          <Button
            variant="ghost"
            size="icon-xs"
            className={cn(
              enabled &&
                'text-blue-500 hover:text-blue-500 bg-blue-500/10 hover:bg-blue-500/15',
              className
            )}
            disabled={pending}
            aria-label={label}
            aria-pressed={enabled}
            onClick={handleClick}
          >
            {pending ? (
              <IconLoader2
                size={18}
                className={cn(
                  'animate-spin',
                  enabled ? 'text-blue-500' : 'text-muted-foreground'
                )}
              />
            ) : (
              <IconWorld
                size={18}
                className={cn(
                  enabled ? 'text-blue-500' : 'text-muted-foreground'
                )}
              />
            )}
          </Button>
        </TooltipTrigger>
        <TooltipContent>
          <p>{t('common:webSearchToggleTooltip')}</p>
        </TooltipContent>
      </Tooltip>
    </TooltipProvider>
  )
})

export default WebSearchToggle
