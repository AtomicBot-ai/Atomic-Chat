import { IconWorld } from '@tabler/icons-react'
import { useEffect, useMemo } from 'react'

import { CopyButton } from '@/containers/CopyButton'
import { useAppState } from '@/hooks/useAppState'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { DecisionState } from '@/services/decision/types'
import type { EmbeddingState } from '@/services/embedding/types'
import { useDecisionStore } from '@/stores/decision-store'
import { useEmbeddingStore } from '@/stores/embedding-store'
import { getModelContextLength } from '@/utils/apiServerCapacity'
import { formatCount } from '@/utils/apiServerStats'
import { getLocalApiServerUrl } from '@/utils/localApiServerControl'

import { MicroLabel, StatusDot, type StatusTone } from './ApiStatusIndicators'

function Field({
  label,
  children,
  className,
}: {
  label: string
  children: React.ReactNode
  className?: string
}) {
  return (
    <div className={cn('min-w-0', className)}>
      <MicroLabel>{label}</MicroLabel>
      <div className="mt-0.5 text-sm text-foreground">{children}</div>
    </div>
  )
}

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
 * clients pass as `model`, or `null` when none. What it reads comes from the
 * running process, or from the catalog until the process has said.
 */
function useServedEmbeddingModel(): {
  id: string
  ready: boolean
  starting: boolean
  readsImages: boolean
} | null {
  const status = useEmbeddingStore((s) => s.status)
  const config = useEmbeddingStore((s) => s.config)
  const catalog = useEmbeddingStore((s) => s.catalog)

  useEffect(() => useEmbeddingStore.getState().bind(), [])

  if (!status?.enabled || !EMBEDDING_SERVED_STATES.has(status.state))
    return null
  const id = status.model_id || config?.model_id || ''
  if (!id) return null
  const modalities =
    status.modalities.length > 0
      ? status.modalities
      : (catalog.models.find((model) => model.id === id)?.modalities ?? [])
  return {
    id,
    ready: status.state === 'ready',
    starting: status.state === 'starting' || status.state === 'restarting',
    readsImages: (modalities as readonly string[]).includes('image'),
  }
}

/** Single-quoted for a POSIX shell. */
const shellQuote = (value: string) => `'${value.replace(/'/g, `'\\''`)}'`

/** A `POST /embeddings` a client can paste, with the key header when the server needs one. */
function embeddingCurl(endpoint: string, body: unknown, authRequired: boolean) {
  return [
    `curl -X POST ${shellQuote(endpoint)} \\`,
    `  -H 'Content-Type: application/json' \\`,
    ...(authRequired ? [`  -H 'Authorization: Bearer YOUR_API_KEY' \\`] : []),
    `  -d ${shellQuote(JSON.stringify(body))}`,
  ].join('\n')
}

export function ApiConnectionStrip() {
  const { t } = useTranslation()
  const { serverStatus, activeModels } = useAppState()
  const decisionModel = useServedDecisionModel()
  const embeddingModel = useServedEmbeddingModel()
  const { serverHost, serverPort, apiPrefix, apiKey } = useLocalApiServer()

  const url = useMemo(
    () => getLocalApiServerUrl(),
    // Recompute when any part of the address changes.
    // eslint-disable-next-line react-hooks/exhaustive-deps
    [serverHost, serverPort, apiPrefix]
  )

  const embeddingsEndpoint = `${url.replace(/\/+$/, '')}/embeddings`
  const authRequired = apiKey.trim().length > 0

  const loadedModel = activeModels[0] ?? null
  const contextLength = getModelContextLength(loadedModel)

  const { tone, label }: { tone: StatusTone; label: string } =
    serverStatus === 'stopped'
      ? { tone: 'idle', label: t('api:status.stopped') }
      : serverStatus === 'pending'
        ? { tone: 'pending', label: t('api:status.starting') }
        : loadedModel || decisionModel?.ready || embeddingModel?.ready
          ? { tone: 'ready', label: t('api:status.ready') }
          : { tone: 'idle', label: t('api:status.noModel') }

  return (
    <div className="flex flex-wrap items-center gap-x-8 gap-y-3 rounded-lg border border-border bg-card px-4 py-3">
      <IconWorld size={18} className="shrink-0 text-muted-foreground" />

      <Field label={t('api:strip.baseUrl')}>
        <span className="flex items-center gap-1 font-mono text-xs">
          <a
            href={url}
            target="_blank"
            rel="noreferrer"
            className="underline underline-offset-2 hover:text-foreground"
          >
            {url}
          </a>
          <CopyButton text={url} />
        </span>
      </Field>

      <Field label={t('api:strip.status')}>
        <span className="flex items-center gap-1.5">
          <StatusDot tone={tone} />
          {label}
        </span>
      </Field>

      <Field label={t('api:strip.loadedModel')} className="flex-1">
        <span className="block truncate" title={loadedModel ?? undefined}>
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
        </span>
      </Field>

      {decisionModel && (
        <Field label={t('api:strip.decisionModel')} className="flex-1">
          <span className="block truncate" title={decisionModel.name}>
            {decisionModel.name}
            {decisionModel.starting && (
              <span className="text-muted-foreground">
                {' · '}
                {t('api:status.starting')}
              </span>
            )}
          </span>
        </Field>
      )}

      {embeddingModel && (
        <Field label={t('api:strip.embeddingModel')} className="flex-1">
          <span className="flex min-w-0 flex-wrap items-center gap-x-2 gap-y-1">
            <span
              className="min-w-0 truncate font-mono text-xs"
              title={embeddingModel.id}
            >
              {embeddingModel.id}
              {embeddingModel.starting && (
                <span className="font-sans text-muted-foreground">
                  {' · '}
                  {t('api:status.starting')}
                </span>
              )}
            </span>
            <CopyButton
              text={embeddingModel.id}
              ariaLabel={t('api:strip.copyEmbeddingModel')}
            />
            <CopyButton
              text={embeddingCurl(
                embeddingsEndpoint,
                { model: embeddingModel.id, input: 'Hello, world' },
                authRequired
              )}
              label={t('api:strip.copyTextExample')}
            />
            {embeddingModel.readsImages && (
              <CopyButton
                text={embeddingCurl(
                  embeddingsEndpoint,
                  {
                    model: embeddingModel.id,
                    input: [
                      {
                        content: [
                          {
                            type: 'image_url',
                            image_url: { url: 'data:image/png;base64,...' },
                          },
                        ],
                      },
                    ],
                  },
                  authRequired
                )}
                label={t('api:strip.copyImageExample')}
              />
            )}
          </span>
        </Field>
      )}
    </div>
  )
}
