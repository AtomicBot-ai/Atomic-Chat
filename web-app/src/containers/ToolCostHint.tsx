import { memo, useMemo, useState } from 'react'
import { IconAlertTriangle, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { MCP_CONNECTORS, findInstalledServer } from '@/constants/mcp-connectors'
import { useAppState } from '@/hooks/useAppState'
import { useMCPServers } from '@/hooks/useMCPServers'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useToolAvailable } from '@/hooks/useToolAvailable'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatTokenCount } from '@/lib/tool-cost'
import { isLocalProvider } from '@/utils/registerRemoteProvider'

/** Threads whose hint the user closed; in-memory on purpose (per session). */
const dismissed = new Set<string>()

type ToolCostHintProps = {
  threadId?: string
  initialMessage?: boolean
}

/**
 * One-line notice above the composer when the connected connectors' tool
 * definitions take a large share of a local model's context window
 * (`ToolCostReport.tooHeavy`). It names the heavy connectors and offers to
 * switch them off for this chat — the app measures and helps, the choice
 * stays with the user. Cloud models are not affected and get no hint.
 */
const ToolCostHint = memo(function ToolCostHint({
  threadId,
  initialMessage = false,
}: ToolCostHintProps) {
  const { t } = useTranslation()
  const key = initialMessage ? '' : (threadId ?? '')
  const report = useAppState((state) => state.toolCostReports[key])
  const selectedProvider = useModelProvider((state) => state.selectedProvider)
  const mcpServers = useMCPServers((state) => state.mcpServers)
  const setServerMutedForThread = useToolAvailable(
    (state) => state.setServerMutedForThread
  )
  const setDefaultServerMuted = useToolAvailable(
    (state) => state.setDefaultServerMuted
  )
  const [, bump] = useState(0)

  const displayName = useMemo(() => {
    const names = new Map<string, string>()
    for (const connector of MCP_CONNECTORS) {
      const hit = findInstalledServer(connector, mcpServers)
      if (hit) names.set(hit.key, connector.name)
    }
    return (server: string) => names.get(server) ?? server
  }, [mcpServers])

  if (!report?.tooHeavy || !isLocalProvider(selectedProvider)) return null
  if (dismissed.has(key)) return null

  const heavy =
    report.heavyServers.length > 0
      ? report.heavyServers
      : report.perServer.slice(0, 1).map((s) => s.server)
  if (heavy.length === 0) return null

  const mute = (server: string) => {
    if (initialMessage || !threadId) setDefaultServerMuted(server, true)
    else setServerMutedForThread(threadId, server, true)
  }
  const dismiss = () => {
    dismissed.add(key)
    bump((n) => n + 1)
  }

  return (
    <div
      className="mx-4 mt-3 flex items-start gap-2 rounded-lg border border-amber-500/40 bg-amber-500/10 px-3 py-2 text-xs"
      data-testid="tool-cost-hint"
      role="status"
    >
      <IconAlertTriangle
        size={16}
        className="mt-0.5 shrink-0 text-amber-600 dark:text-amber-400"
      />
      <div className="min-w-0 flex-1">
        <p className="font-medium">
          {t('common:toolCostHint.title', {
            tokens: formatTokenCount(report.totalTokens),
            ctx: report.ctxLen ? formatTokenCount(report.ctxLen) : '?',
          })}
        </p>
        <p className="text-muted-foreground">
          {t('common:toolCostHint.body', {
            servers: heavy.map(displayName).join(', '),
          })}
        </p>
        <div className="mt-1.5 flex flex-wrap gap-1.5">
          {heavy.map((server) => (
            <Button
              key={server}
              size="sm"
              variant="outline"
              className="h-6 px-2 text-xs"
              data-testid={`tool-cost-hint-mute-${server}`}
              onClick={() => mute(server)}
            >
              {t('common:toolCostHint.mute', { server: displayName(server) })}
            </Button>
          ))}
          <Button
            size="sm"
            variant="ghost"
            className="h-6 px-2 text-xs text-muted-foreground"
            onClick={dismiss}
          >
            {t('common:toolCostHint.dismiss')}
          </Button>
        </div>
      </div>
      <button
        type="button"
        className="shrink-0 rounded-sm p-0.5 text-muted-foreground hover:text-foreground"
        aria-label={t('common:toolCostHint.dismiss')}
        onClick={dismiss}
      >
        <IconX size={14} />
      </button>
    </div>
  )
})

export default ToolCostHint
