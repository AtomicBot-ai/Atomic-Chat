import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ApiLogEntry, ApiRequestEntry } from '@/types/apiServerLog'
import { getModelContextLength } from '@/utils/apiServerCapacity'
import { endpointPath } from '@/utils/apiServerLogNormalize'
import {
  formatCount,
  formatMs,
  formatTime,
  formatTokensPerSecond,
} from '@/utils/apiServerStats'

import { MicroLabel, RequestStatusBadge } from './ApiStatusIndicators'

function StatField({
  label,
  value,
  hint,
}: {
  label: string
  value: string
  hint?: string
}) {
  return (
    <div className="min-w-0">
      <MicroLabel>{label}</MicroLabel>
      <p
        className="mt-0.5 truncate text-sm tabular-nums text-foreground"
        title={hint ?? value}
      >
        {value}
      </p>
    </div>
  )
}

function PreviewBlock({
  label,
  text,
  fallback,
}: {
  label: string
  text?: string
  fallback: string
}) {
  return (
    <div>
      <MicroLabel className="mb-1">{label}</MicroLabel>
      <div className="rounded-lg border border-border bg-secondary/30 p-3">
        {text ? (
          <pre className="max-h-48 overflow-auto whitespace-pre-wrap break-words font-mono text-xs text-foreground">
            {text}
          </pre>
        ) : (
          <p className="text-xs text-muted-foreground">{fallback}</p>
        )}
      </div>
    </div>
  )
}

function EmptyPane({ message }: { message: string }) {
  return (
    <div className="flex h-full items-center justify-center rounded-lg border border-border bg-card p-6">
      <p className="max-w-xs text-center text-sm text-muted-foreground">
        {message}
      </p>
    </div>
  )
}

export function ApiRequestInspector({
  entry,
  hasSelection,
}: {
  entry?: ApiLogEntry
  hasSelection: boolean
}) {
  const { t } = useTranslation()
  const apiPrefix = useLocalApiServer((state) => state.apiPrefix)

  if (!entry) {
    return (
      <EmptyPane
        message={
          hasSelection ? t('api:detail.gone') : t('api:detail.selectPrompt')
        }
      />
    )
  }

  if (entry.kind === 'event') {
    return (
      <div className="flex h-full min-h-0 flex-col gap-3 overflow-y-auto rounded-lg border border-border bg-card p-4">
        <p className="font-studio text-base font-medium">{entry.title}</p>
        {entry.detail && (
          <p className="font-mono text-xs text-muted-foreground">
            {entry.detail}
          </p>
        )}
        <StatField
          label={t('api:detail.started')}
          value={formatTime(entry.startedAt)}
        />
      </div>
    )
  }

  const request = entry as ApiRequestEntry
  const generationMs =
    request.durationMs !== undefined
      ? Math.max(request.durationMs - (request.ttftMs ?? 0), 0)
      : undefined

  const promptSpeed =
    request.promptPerSecond ??
    (request.promptTokens && request.ttftMs
      ? request.promptTokens / (request.ttftMs / 1000)
      : undefined)

  const generationSpeed =
    request.predictedPerSecond ??
    (request.completionTokens && generationMs
      ? request.completionTokens / (Math.max(generationMs, 1) / 1000)
      : undefined)

  const contextLength = getModelContextLength(request.model)
  const tokenValue = (value?: number, estimated?: boolean) =>
    value === undefined
      ? '–'
      : `${estimated ? '~' : ''}${formatCount(value)}`

  return (
    <div className="flex h-full min-h-0 flex-col gap-4 overflow-y-auto rounded-lg border border-border bg-card p-4">
      <div className="flex items-center justify-between gap-2">
        <RequestStatusBadge status={request.status} />
        <span
          className="truncate font-mono text-[11px] text-muted-foreground"
          title={request.id}
        >
          {request.id}
        </span>
      </div>

      <div className="min-w-0">
        <p className="truncate font-mono text-sm text-foreground">
          {request.method} {endpointPath(request.endpoint, apiPrefix)}
        </p>
        <p
          className="truncate text-xs text-muted-foreground"
          title={request.model ?? undefined}
        >
          {request.model ?? '—'}
        </p>
      </div>

      {request.errorKind && (
        <div className="rounded-lg border border-red-200 bg-red-50 p-2 text-xs text-red-700 dark:border-red-900 dark:bg-red-950/40 dark:text-red-200">
          {request.errorKind}
          {request.httpStatus ? ` · HTTP ${request.httpStatus}` : ''}
        </div>
      )}

      <div className="grid grid-cols-2 gap-x-6 gap-y-3 sm:grid-cols-3">
        <StatField
          label={t('api:detail.started')}
          value={formatTime(request.startedAt)}
        />
        <StatField
          label={t('api:detail.duration')}
          value={formatMs(request.durationMs)}
        />
        <StatField
          label={t('api:detail.promptTokens')}
          value={tokenValue(request.promptTokens)}
        />
        <StatField
          label={t('api:detail.completionTokens')}
          value={tokenValue(request.completionTokens, request.tokensEstimated)}
          hint={request.tokensEstimated ? t('api:detail.estimated') : undefined}
        />
        <StatField
          label={t('api:detail.totalTokens')}
          value={tokenValue(request.totalTokens)}
        />
        <StatField
          label={t('api:detail.context')}
          value={contextLength ? formatCount(contextLength) : '–'}
        />
        <StatField
          label={t('api:detail.firstToken')}
          value={formatMs(request.ttftMs)}
        />
        <StatField
          label={t('api:detail.generating')}
          value={formatMs(generationMs)}
        />
        <StatField
          label={t('api:detail.promptSpeed')}
          value={formatTokensPerSecond(promptSpeed)}
        />
        <StatField
          label={t('api:detail.generationSpeed')}
          value={formatTokensPerSecond(generationSpeed)}
        />
        <StatField
          label={t('api:detail.stopReason')}
          value={request.finishReason ?? '–'}
        />
      </div>

      <PreviewBlock
        label={t('api:detail.prompt')}
        text={request.promptPreview}
        fallback={t('api:detail.noPrompt')}
      />
      {request.hasNonTextParts && (
        <p className="-mt-2 text-[11px] text-muted-foreground">
          {t('api:detail.nonTextParts')}
        </p>
      )}
      <PreviewBlock
        label={t('api:detail.reply')}
        text={request.replyPreview}
        fallback={t('api:detail.noReply')}
      />
    </div>
  )
}
