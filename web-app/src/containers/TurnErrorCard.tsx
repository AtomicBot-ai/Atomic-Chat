import { useId } from 'react'
import {
  IconAlertCircle,
  IconChevronRight,
  IconRefresh,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { LinkifiedText } from '@/components/LinkifiedText'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  summarizeTurnError,
  type TurnErrorAction,
  type TurnErrorContext,
} from '@/lib/turn-error-summary'

type TurnErrorCardProps = Omit<TurnErrorContext, 't'> & {
  error: unknown
  onRetry: () => void
  onShortenHistory: () => void
  onIncreaseContext: () => void
  onOpenEngineSettings: (engineId: string) => void
}

/**
 * The card under a chat turn that failed: what happened in readable words,
 * one labelled recovery action, and the raw diagnostic behind a collapsed
 * Details region when a readable sentence stands in for it (design review D7).
 * The failed message and its attachments stay in the thread; Retry sends
 * them again.
 */
export function TurnErrorCard({
  error,
  onRetry,
  onShortenHistory,
  onIncreaseContext,
  onOpenEngineSettings,
  ...context
}: TurnErrorCardProps) {
  const { t } = useTranslation()
  const titleId = useId()
  const summary = summarizeTurnError(error, { ...context, t })

  const runAction = (action: TurnErrorAction) => {
    switch (action.type) {
      case 'open-engine-settings':
        return onOpenEngineSettings(action.engineId)
      case 'shorten-history':
        return onShortenHistory()
      case 'increase-context':
        return onIncreaseContext()
      case 'retry':
        return onRetry()
    }
  }

  const { action } = summary
  const actionLabel =
    action.type === 'open-engine-settings'
      ? `Open ${action.engineLabel} settings`
      : action.type === 'shorten-history'
        ? t('chat:turnRecovery.shortenHistory')
        : action.type === 'increase-context'
          ? 'Increase Context Size'
          : t('chat:turnRecovery.retry')
  const ActionIcon =
    action.type === 'shorten-history' || action.type === 'retry'
      ? IconRefresh
      : IconAlertCircle

  return (
    <div
      role="alert"
      aria-labelledby={titleId}
      data-testid="turn-error-card"
      data-kind={summary.kind}
      // The icon shares the title's row, so it stays centred on it at every
      // interface font size; everything else lines up under the title.
      className="mx-4 my-2 grid grid-cols-[auto_minmax(0,1fr)] items-center gap-x-3 rounded-lg border border-destructive/10 bg-destructive/10 px-4 py-3"
    >
      <IconAlertCircle
        aria-hidden="true"
        className="size-4 shrink-0 text-destructive"
      />
      <p id={titleId} className="text-sm font-medium text-destructive">
        {summary.title}
      </p>
      <div className="col-start-2 min-w-0">
        <p className="mt-1 text-sm break-words text-muted-foreground">
          {/* The raw provider message can embed links (e.g. the model-policy
              banner's "Open dashboard" / "View agreement"); render them
              clickable instead of as dead text. */}
          <LinkifiedText text={summary.body} />
        </p>
        {summary.details && (
          <details className="group mt-2">
            <summary className="inline-flex list-none items-center gap-1 rounded-sm text-sm text-muted-foreground outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring/50 [&::-webkit-details-marker]:hidden">
              <IconChevronRight
                aria-hidden="true"
                className="size-3.5 shrink-0 transition-transform group-open:rotate-90"
              />
              {t('chat:turnRecovery.details')}
            </summary>
            <pre className="mt-2 max-h-48 overflow-auto rounded-md bg-background/60 p-2 font-mono text-xs whitespace-pre-wrap wrap-anywhere text-muted-foreground">
              {summary.details}
            </pre>
          </details>
        )}
        <Button
          variant="outline"
          size="sm"
          className="mt-3"
          onClick={() => runAction(action)}
        >
          <ActionIcon aria-hidden="true" className="size-4" />
          {actionLabel}
        </Button>
      </div>
    </div>
  )
}
