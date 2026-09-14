import { useEffect, useMemo, useState } from 'react'
import { IconAlertTriangle } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import type { MCPServerConfig } from '@/hooks/useMCPServers'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { describeConnector } from '@/lib/review-before-use'

export type ConnectorTool = {
  name: string
  description?: string
  /** What the connector says about the tool. It labels its own tools. */
  readOnly?: boolean
}

type ConnectorReviewDialogProps = {
  open: boolean
  name: string
  config: MCPServerConfig
  /**
   * Lists the connector's tools without letting the AI use any of them. For a
   * local program this has to start the program, so the dialog only calls it
   * when the user asks.
   */
  onListTools: () => Promise<ConnectorTool[]>
  onAllow: () => void
  onCancel: () => void
}

type ToolsState =
  | { status: 'idle' }
  | { status: 'loading' }
  | { status: 'ready'; tools: ConnectorTool[] }
  | { status: 'failed'; error: string }

/**
 * Review before use for MCP connectors (Task 28, decision D36): every
 * connector - built in, from the catalog, added by hand or imported - shows
 * what it runs or where it connects, the names of the secrets it gets, and any
 * warnings, with Allow / Preview / Cancel. Closing the dialog any other way is
 * Cancel.
 */
export function ConnectorReviewDialog({
  open,
  name,
  config,
  onListTools,
  onAllow,
  onCancel,
}: ConnectorReviewDialogProps) {
  const { t } = useTranslation()
  const summary = useMemo(() => describeConnector(config), [config])
  const [previewOpen, setPreviewOpen] = useState(false)
  const [tools, setTools] = useState<ToolsState>({ status: 'idle' })

  const listTools = async () => {
    setTools({ status: 'loading' })
    try {
      setTools({ status: 'ready', tools: await onListTools() })
    } catch (error) {
      setTools({
        status: 'failed',
        error: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // A web service is only contacted to list its tools; a local program is
  // never started without the user asking (see the button below).
  useEffect(() => {
    if (previewOpen && summary.kind === 'website' && tools.status === 'idle') {
      void listTools()
    }
    // listTools only reads props; running it once per open preview is the point.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [previewOpen, summary.kind, tools.status])

  const target = summary.kind === 'program' ? summary.runs : summary.address

  return (
    <Dialog
      open={open}
      onOpenChange={(nextOpen) => {
        if (!nextOpen) onCancel()
      }}
    >
      <DialogContent className="max-h-[85vh] overflow-y-auto sm:max-w-2xl">
        <DialogHeader>
          <DialogTitle>{t('review:connectorTitle', { name })}</DialogTitle>
          <DialogDescription>
            {t(`review:connector.${summary.kind}`)}
          </DialogDescription>
        </DialogHeader>

        <section className="space-y-1 text-sm">
          <h3 className="font-medium">
            {t(
              summary.kind === 'program'
                ? 'review:connector.runs'
                : 'review:connector.address'
            )}
          </h3>
          <code className="block whitespace-pre-wrap break-all rounded bg-secondary/40 p-2 text-xs">
            {target}
          </code>
        </section>

        <section className="space-y-1 text-sm">
          <h3 className="font-medium">{t('review:connector.secrets')}</h3>
          {summary.secretNames.length > 0 ? (
            <ul className="flex flex-wrap gap-1.5">
              {summary.secretNames.map((secret) => (
                <li
                  key={secret}
                  className="rounded bg-secondary/40 px-1.5 py-0.5 font-mono text-xs"
                >
                  {secret}
                </li>
              ))}
            </ul>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('review:connector.noSecrets')}
            </p>
          )}
        </section>

        <section className="space-y-2">
          <h3 className="text-sm font-medium">{t('review:warningsTitle')}</h3>
          {summary.warnings.length > 0 ? (
            <>
              <ul aria-label={t('review:warnings')} className="space-y-2">
                {summary.warnings.map((warning) => (
                  <li
                    key={warning.id}
                    className="rounded-md border border-destructive/40 bg-destructive/5 p-2 text-sm"
                  >
                    <p className="flex items-center gap-1.5 font-medium">
                      <IconAlertTriangle className="size-4 shrink-0 text-destructive" />
                      {t(`review:warning.${warning.id}`)}
                    </p>
                    <code className="mt-1 block whitespace-pre-wrap break-all text-xs text-muted-foreground">
                      {warning.evidence}
                    </code>
                  </li>
                ))}
              </ul>
              <p className="text-xs text-muted-foreground">
                {t('review:warningsNotAGuarantee')}
              </p>
            </>
          ) : (
            <p className="text-xs text-muted-foreground">
              {t('review:noWarningsNotAGuarantee')}
            </p>
          )}
        </section>

        {previewOpen && (
          <section
            aria-label={t('review:previewTitle')}
            className="space-y-2 rounded-md border p-2 text-sm"
          >
            <h3 className="font-medium">{t('review:previewTitle')}</h3>
            {summary.kind === 'program' && (
              <>
                <code className="block whitespace-pre-wrap break-all rounded bg-secondary/40 p-2 text-xs">
                  {summary.runs}
                </code>
                {tools.status === 'idle' && (
                  <div className="space-y-2">
                    <p className="text-xs text-muted-foreground">
                      {t('review:connector.listToolsRunsProgram')}
                    </p>
                    <Button
                      size="sm"
                      variant="outline"
                      onClick={() => void listTools()}
                    >
                      {t('review:connector.listTools')}
                    </Button>
                  </div>
                )}
              </>
            )}
            {tools.status === 'loading' && (
              <p className="text-xs text-muted-foreground">
                {t('review:connector.loadingTools')}
              </p>
            )}
            {tools.status === 'failed' && (
              <p className="text-xs text-destructive">
                {t('review:connector.toolsUnavailable', { error: tools.error })}
              </p>
            )}
            {tools.status === 'ready' && <ToolLists tools={tools.tools} />}
          </section>
        )}

        <DialogFooter className="gap-2">
          <Button variant="ghost" onClick={onCancel}>
            {t('review:cancel')}
          </Button>
          <Button
            variant="outline"
            aria-expanded={previewOpen}
            onClick={() => setPreviewOpen((current) => !current)}
          >
            {t('review:preview')}
          </Button>
          <Button onClick={onAllow}>{t('review:allow')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

function ToolLists({ tools }: { tools: ConnectorTool[] }) {
  const { t } = useTranslation()
  const reading = tools.filter((tool) => tool.readOnly === true)
  const changing = tools.filter((tool) => tool.readOnly !== true)

  const renderList = (label: string, items: ConnectorTool[]) => (
    <div className="space-y-1">
      <h4 className="text-xs font-medium">{label}</h4>
      <ul aria-label={label} className="space-y-1">
        {items.length === 0 ? (
          <li className="text-xs text-muted-foreground">
            {t('review:connector.noTools')}
          </li>
        ) : (
          items.map((tool) => (
            <li key={tool.name} className="text-xs">
              <span className="font-mono font-medium">{tool.name}</span>
              {tool.description && (
                <span className="text-muted-foreground">
                  {' '}
                  - {tool.description}
                </span>
              )}
            </li>
          ))
        )}
      </ul>
    </div>
  )

  return (
    <div className="space-y-2">
      {renderList(t('review:connector.toolsThatChange'), changing)}
      {renderList(t('review:connector.toolsThatRead'), reading)}
      <p className="text-xs text-muted-foreground">
        {t('review:connector.toolsSelfLabelled')}
      </p>
    </div>
  )
}
