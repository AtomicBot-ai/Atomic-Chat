import {
  IconCheck,
  IconCopy,
  IconPhoto,
  IconTerminal2,
} from '@tabler/icons-react'
import { useEffect, useMemo, useState } from 'react'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import {
  StatusDot,
  type StatusTone,
} from '@/containers/api/ApiStatusIndicators'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useRemoteAccessStore } from '@/hooks/useRemoteAccess'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { copyToClipboard } from '@/lib/clipboard'
import {
  API_KEY_PLACEHOLDER,
  IMAGE_FILE_PLACEHOLDER,
  embeddingImageCommand,
  embeddingTextCommand,
} from '@/lib/embedding/examples'
import type { DecisionState } from '@/services/decision/types'
import type { EmbeddingState } from '@/services/embedding/types'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { formatCount } from '@/utils/apiServerStats'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'

import { ServerCopyButton } from './ServerPageParts'
import { useServedContextLength } from './useServedContextLength'

/** `idle` is an enabled module unloaded for idling: the next request starts it. */
const DECISION_SERVED_STATES = new Set<DecisionState>([
  'idle',
  'starting',
  'ready',
  'restarting',
])

/** The decision model the server answers `/systemone` with, or `null` when none. */
function useServedDecisionModel(): {
  name: string
  ready: boolean
  starting: boolean
} | null {
  const status = useDecisionStore((s) => s.status)
  const config = useDecisionStore((s) => s.config)
  const catalog = useDecisionStore((s) => s.catalog)

  useEffect(() => useDecisionStore.getState().bind(), [])

  if (!status?.enabled || !DECISION_SERVED_STATES.has(status.state)) return null
  const id = config?.model_id ?? ''
  const name =
    catalog.models.find((model) => model.id === id)?.name ||
    id ||
    status.model_path?.split(/[\\/]/).pop() ||
    ''
  if (!name) return null
  return {
    name,
    ready: status.state === 'ready',
    starting: status.state === 'starting' || status.state === 'restarting',
  }
}

/** `idle` is an enabled module unloaded for idling: the next request starts it. */
const EMBEDDING_SERVED_STATES = new Set<EmbeddingState>([
  'idle',
  'starting',
  'ready',
  'restarting',
])

/**
 * The embedding model the server answers `/embeddings` with, by the id
 * clients pass as `model`, or `null` when none. What it reads and the length
 * of its vectors come from the running process, or from the catalog until the
 * process has said; its query prefix from the catalog (a llama.cpp model has
 * none to show).
 */
function useServedEmbeddingModel(): {
  id: string
  ready: boolean
  starting: boolean
  readsImages: boolean
  dims: number | null
  queryPrefix: string
} | null {
  const status = useEmbeddingStore((s) => s.status)
  const config = useEmbeddingStore((s) => s.config)
  const catalog = useEmbeddingStore((s) => s.catalog)

  useEffect(() => useEmbeddingStore.getState().bind(), [])

  if (!status?.enabled || !EMBEDDING_SERVED_STATES.has(status.state))
    return null
  const id = status.model_id || config?.model_id || ''
  if (!id) return null
  const entry = catalog.models.find((model) => model.id === id)
  const modalities =
    status.modalities.length > 0 ? status.modalities : (entry?.modalities ?? [])
  return {
    id,
    ready: status.state === 'ready',
    starting: status.state === 'starting' || status.state === 'restarting',
    readsImages: (modalities as readonly string[]).includes('image'),
    dims: status.dims ?? entry?.dims ?? null,
    queryPrefix: entry?.prompts?.query ?? '',
  }
}

/**
 * An icon that copies `text`, named by its tooltip: what it copies, and what
 * to do with it. A fact stays one line, so the copies sit as icons beside the
 * model id, not buttons.
 */
function CopyIcon({
  text,
  label,
  description,
  icon,
}: {
  text: string
  label: string
  description?: string
  icon: React.ReactNode
}) {
  const [copied, setCopied] = useState(false)
  const copy = async () => {
    if (!(await copyToClipboard(text))) return
    setCopied(true)
    setTimeout(() => setCopied(false), 2000)
  }
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <Button
          variant="ghost"
          size="icon-xs"
          className="shrink-0"
          onClick={copy}
          aria-label={label}
        >
          {copied ? <IconCheck size={16} className="text-primary" /> : icon}
        </Button>
      </TooltipTrigger>
      <TooltipContent className="max-w-xs">
        <p className="font-medium">{label}</p>
        {description && <p className="mt-0.5 opacity-80">{description}</p>}
      </TooltipContent>
    </Tooltip>
  )
}

/** The address clients dial, from the persisted configuration. */
export function useLocalApiServerUrl(): string {
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer()
  return useMemo(
    () => getLocalApiServerUrl(),
    // Recompute when any part of the address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )
}

/**
 * Server → Connections, "Connection details": the address to copy, whether
 * the server is serving, and the facts a client needs — the model it answers
 * with, who can reach it, whether it wants a key — plus the decision and
 * embedding models it also serves, with copyable test commands.
 */
export function ConnectionDetails() {
  const { t } = useTranslation()
  const { serverStatus, activeModels } = useAppState()
  const decisionModel = useServedDecisionModel()
  const embeddingModel = useServedEmbeddingModel()
  const serverHost = useLocalApiServer((state) => state.serverHost)
  const apiKey = useLocalApiServer((state) => state.apiKey)
  const tunnelOnline = useRemoteAccessStore(
    (state) => state.status?.state === 'online'
  )
  const url = useLocalApiServerUrl()

  const embeddingsEndpoint = `${url.replace(/\/+$/, '')}/embeddings`
  const authRequired = apiKey.trim().length > 0
  const apiKeyHint = t('api:strip.apiKeyHint', { key: API_KEY_PLACEHOLDER })

  const loadedModel = activeModels[0] ?? null
  const contextLength = useServedContextLength(loadedModel)

  const { tone, label }: { tone: StatusTone; label: string } =
    serverStatus === 'stopped'
      ? { tone: 'idle', label: t('api:status.stopped') }
      : serverStatus === 'pending'
        ? { tone: 'pending', label: t('api:status.starting') }
        : loadedModel || decisionModel?.ready || embeddingModel?.ready
          ? { tone: 'ready', label: t('api:status.ready') }
          : { tone: 'idle', label: t('api:status.noModel') }

  const access = tunnelOnline
    ? t('api:connections.accessRemote')
    : serverHost === '0.0.0.0'
      ? t('api:connections.accessNetwork')
      : t('api:connections.accessDevice')

  return (
    <section className="sp-panel">
      <div className="sp-row">
        <h2>{t('api:connections.details')}</h2>
        <span className="sp-status">
          <StatusDot tone={tone} />
          {label}
        </span>
      </div>
      <div className="sp-copy-row">
        <code>{url}</code>
        <ServerCopyButton value={url} label={t('api:connections.copyUrl')} />
      </div>
      <dl className="sp-facts">
        <div>
          <dt>{t('api:strip.loadedModel')}</dt>
          <dd className="truncate" title={loadedModel ?? undefined}>
            {loadedModel ?? (
              <span className="text-muted-foreground">
                {t('api:strip.noModel')}
              </span>
            )}
            {loadedModel && contextLength ? (
              <span className="text-muted-foreground">
                {' · '}
                {t('api:strip.ctx', { count: formatCount(contextLength) })}
              </span>
            ) : null}
          </dd>
        </div>
        <div>
          <dt>{t('api:connections.access')}</dt>
          <dd>{access}</dd>
        </div>
        <div>
          <dt>{t('api:connections.auth')}</dt>
          <dd>
            {authRequired
              ? t('api:connections.keyRequired')
              : t('api:connections.noKey')}
          </dd>
        </div>
        {decisionModel && (
          <div>
            <dt>{t('api:strip.decisionModel')}</dt>
            <dd className="truncate" title={decisionModel.name}>
              {decisionModel.name}
              {decisionModel.starting && (
                <span className="text-muted-foreground">
                  {' · '}
                  {t('api:status.starting')}
                </span>
              )}
            </dd>
          </div>
        )}
        {embeddingModel && (
          <div className="sp-fact-wide">
            <dt>{t('api:strip.embeddingModel')}</dt>
            <dd className="flex min-w-0 items-center gap-1 font-mono">
              <span className="min-w-0 truncate" title={embeddingModel.id}>
                {embeddingModel.id}
                {embeddingModel.starting && (
                  <span className="font-sans text-muted-foreground">
                    {' · '}
                    {t('api:status.starting')}
                  </span>
                )}
              </span>
              <span className="flex shrink-0 items-center">
                <CopyIcon
                  text={embeddingModel.id}
                  label={t('api:strip.copyEmbeddingModel')}
                  description={t('api:strip.copyEmbeddingModelHint')}
                  icon={<IconCopy size={16} />}
                />
                <CopyIcon
                  text={embeddingTextCommand(
                    embeddingsEndpoint,
                    embeddingModel.id,
                    embeddingModel.queryPrefix,
                    authRequired
                  )}
                  label={t('api:strip.copyTextTest')}
                  description={[
                    embeddingModel.dims
                      ? t('api:strip.copyTextTestHint', {
                          dims: embeddingModel.dims,
                        })
                      : t('api:strip.copyTextTestHintNoDims'),
                    ...(authRequired ? [apiKeyHint] : []),
                  ].join(' ')}
                  icon={<IconTerminal2 size={16} />}
                />
                {embeddingModel.readsImages && (
                  <CopyIcon
                    text={embeddingImageCommand(
                      embeddingsEndpoint,
                      embeddingModel.id,
                      authRequired
                    )}
                    label={t('api:strip.copyImageTest')}
                    description={[
                      t('api:strip.copyImageTestHint', {
                        file: IMAGE_FILE_PLACEHOLDER,
                      }),
                      ...(authRequired ? [apiKeyHint] : []),
                    ].join(' ')}
                    icon={<IconPhoto size={16} />}
                  />
                )}
              </span>
            </dd>
          </div>
        )}
      </dl>
    </section>
  )
}
