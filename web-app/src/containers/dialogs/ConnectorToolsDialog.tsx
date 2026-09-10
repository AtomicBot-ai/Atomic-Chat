import React, { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Input } from '@/components/ui/input'
import { Switch } from '@/components/ui/switch'
import { ServerIcon } from '@/containers/connectors/ServerIcon'
import type { MCPConnector } from '@/constants/mcp-connectors'
import { useAppState } from '@/hooks/useAppState'
import { createToolKey, useToolAvailable } from '@/hooks/useToolAvailable'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

/**
 * Whose switches the dialog edits. `default` is what new chats (and the index
 * page) start from; `thread` is one chat's own copy, which the composer's
 * plugins menu opens.
 */
export type ConnectorToolsScope =
  | { kind: 'default' }
  | { kind: 'thread'; threadId: string }

interface ConnectorToolsDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  serverKey: string
  connector?: MCPConnector
  scope: ConnectorToolsScope
}

/**
 * Per-tool switches for one connector, plus the connector's own switch for
 * the scope (the same `mutedServers` flag the plugins menu used to flip with
 * its plug button). Tools are read from the live catalog, so a server that is
 * not running lists nothing — the note says so instead of showing stale rows.
 */
export default function ConnectorToolsDialog({
  open,
  onOpenChange,
  serverKey,
  connector,
  scope,
}: ConnectorToolsDialogProps) {
  const { t } = useTranslation()
  const [query, setQuery] = useState('')

  useEffect(() => {
    if (!open) setQuery('')
  }, [open])

  const allTools = useAppState((state) => state.tools)
  const tools = useMemo(
    () =>
      allTools
        .filter((tool) => tool.server === serverKey)
        .sort((a, b) => a.name.localeCompare(b.name)),
    [allTools, serverKey]
  )

  const threadId = scope.kind === 'thread' ? scope.threadId : undefined
  const disabledKeys = useToolAvailable((state) =>
    threadId
      ? (state.disabledTools[threadId] ?? state.defaultDisabledTools)
      : state.defaultDisabledTools
  )
  const muted = useToolAvailable((state) =>
    (threadId
      ? (state.mutedServers[threadId] ?? state.defaultMutedServers)
      : state.defaultMutedServers
    ).includes(serverKey)
  )
  const setToolsDisabledForThread = useToolAvailable(
    (state) => state.setToolsDisabledForThread
  )
  const setDefaultToolsDisabled = useToolAvailable(
    (state) => state.setDefaultToolsDisabled
  )
  const setServerMutedForThread = useToolAvailable(
    (state) => state.setServerMutedForThread
  )
  const setDefaultServerMuted = useToolAvailable(
    (state) => state.setDefaultServerMuted
  )

  const disabled = useMemo(() => new Set(disabledKeys), [disabledKeys])
  const keyOf = (name: string) => createToolKey(serverKey, name)
  const enabledCount = tools.filter(
    (tool) => !disabled.has(keyOf(tool.name))
  ).length

  const setDisabled = (keys: string[], value: boolean) => {
    if (threadId) setToolsDisabledForThread(threadId, keys, value)
    else setDefaultToolsDisabled(keys, value)
  }

  const setMuted = (value: boolean) => {
    if (threadId) setServerMutedForThread(threadId, serverKey, value)
    else setDefaultServerMuted(serverKey, value)
    // Switching the connector back on while every tool is off would change
    // nothing visible, so it brings the tools with it.
    if (!value && tools.length > 0 && enabledCount === 0) {
      setDisabled(
        tools.map((tool) => keyOf(tool.name)),
        false
      )
    }
  }

  const needle = query.trim().toLowerCase()
  const visible = needle
    ? tools.filter(
        (tool) =>
          tool.name.toLowerCase().includes(needle) ||
          tool.description?.toLowerCase().includes(needle)
      )
    : tools

  const name = connector?.name ?? serverKey

  // A portal still bubbles React events up the tree that rendered it. In the
  // composer that tree is the plugins button and its tooltip, which would
  // open on the dialog's own focus and on the pointer crossing its overlay.
  // The wrapper takes no layout of its own and swallows them.
  const stop = (e: React.SyntheticEvent) => e.stopPropagation()

  return (
    <div
      className="contents"
      onFocus={stop}
      onPointerMove={stop}
      onPointerDown={stop}
      onClick={stop}
    >
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent
          className="sm:max-w-lg lg:max-w-lg xl:max-w-lg"
          data-testid="connector-tools-dialog"
        >
          <DialogHeader>
            <div className="flex items-center gap-3">
              <ServerIcon connector={connector} name={name} />
              <div className="min-w-0">
                <DialogTitle className="truncate">
                  {t('common:connectorTools.title', { name })}
                </DialogTitle>
                <DialogDescription className="mt-1">
                  {scope.kind === 'thread'
                    ? t('common:connectorTools.scopeChat')
                    : t('common:connectorTools.scopeDefault')}
                </DialogDescription>
              </div>
            </div>
          </DialogHeader>

          <label className="flex items-center justify-between gap-3 rounded-lg border px-3 py-2">
            <div className="min-w-0">
              <div className="text-sm font-medium text-foreground">
                {scope.kind === 'thread'
                  ? t('common:connectorTools.onForChat')
                  : t('common:connectorTools.onByDefault')}
              </div>
              <div className="text-xs text-muted-foreground">
                {muted
                  ? t('common:connectorTools.mutedHint')
                  : t('common:connectorTools.summary', {
                      enabled: enabledCount,
                      count: tools.length,
                    })}
              </div>
            </div>
            <Switch
              checked={!muted}
              onCheckedChange={(checked) => setMuted(!checked)}
              data-testid="connector-tools-master"
            />
          </label>

          {tools.length > 0 && (
            <div className="flex items-center gap-2">
              <Input
                value={query}
                onChange={(e) => setQuery(e.target.value)}
                placeholder={t('common:connectorTools.search')}
                aria-label={t('common:connectorTools.search')}
                className="h-8 flex-1"
              />
              <Button
                size="sm"
                variant="ghost"
                disabled={muted || enabledCount === tools.length}
                onClick={() =>
                  setDisabled(
                    tools.map((tool) => keyOf(tool.name)),
                    false
                  )
                }
              >
                {t('common:connectorTools.enableAll')}
              </Button>
              <Button
                size="sm"
                variant="ghost"
                disabled={muted || enabledCount === 0}
                onClick={() =>
                  setDisabled(
                    tools.map((tool) => keyOf(tool.name)),
                    true
                  )
                }
              >
                {t('common:connectorTools.disableAll')}
              </Button>
            </div>
          )}

          <div
            className={cn(
              'max-h-[50vh] overflow-y-auto',
              muted && 'opacity-60'
            )}
          >
            {tools.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('common:connectorTools.noTools')}
              </p>
            )}
            {tools.length > 0 && visible.length === 0 && (
              <p className="py-6 text-center text-sm text-muted-foreground">
                {t('common:connectorTools.noMatches')}
              </p>
            )}
            {visible.map((tool) => {
              const key = keyOf(tool.name)
              const on = !disabled.has(key)
              return (
                <label
                  key={key}
                  className="flex items-start justify-between gap-3 border-b py-2 last:border-b-0"
                  data-testid={`connector-tool-${tool.name}`}
                >
                  <div className="min-w-0">
                    <div
                      className={cn(
                        'truncate font-mono text-xs text-foreground',
                        !on && 'text-muted-foreground line-through'
                      )}
                    >
                      {tool.name}
                    </div>
                    {tool.description && (
                      <p
                        className="line-clamp-2 text-xs text-muted-foreground"
                        title={tool.description}
                      >
                        {tool.description}
                      </p>
                    )}
                  </div>
                  <Switch
                    aria-label={tool.name}
                    checked={on && !muted}
                    disabled={muted}
                    onCheckedChange={(checked) => setDisabled([key], !checked)}
                  />
                </label>
              )
            })}
          </div>
        </DialogContent>
      </Dialog>
    </div>
  )
}
