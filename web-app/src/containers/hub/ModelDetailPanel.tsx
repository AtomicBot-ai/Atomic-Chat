import type { ReactNode } from 'react'
import { ChevronDown, ExternalLink, Heart } from 'lucide-react'
import { IconDownload, IconHeart } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import { Skeleton } from '@/components/ui/skeleton'
import { ModelLogo } from '@/containers/ModelLogo'
import { DownloadOptionsSelect } from '@/containers/hub/DownloadOptionsSelect'
import { PendingValue } from '@/containers/hub/PendingValue'
import { FitBadge } from '@/containers/hub/FitBadge'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { HUB_FORMAT_LABELS } from '@/lib/hub-filters'
import { hubEngineLabel, type HubEngineId } from '@/lib/hub-model-engines'
import { hubRepoId, type HubModelFacts } from '@/lib/hub-model-facts'
import { foundryLocalOf } from '@/lib/foundry-local/hub'
import type { UnservedCheckpoint } from '@/lib/managed-engine/hub-state'
import { hubKey, type ManagedEngine } from '@/lib/managed-engines'
import { formatDownloads, formatTimeAgo } from '@/lib/model-card'
import { cn } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'

/**
 * Where a model comes from, as the expanded row links it: its Hugging Face
 * page, or for a Foundry Local model the catalog it was listed from, which has
 * no page of its own to open.
 */
function SourceLink({ model }: { model: CatalogModel }) {
  const { t } = useTranslation()
  const foundry = foundryLocalOf(model)
  if (foundry) {
    return (
      <span className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs text-muted-foreground">
        <img
          src="/images/model-provider/foundry-local.svg"
          alt=""
          className="size-4"
        />
        {foundry.origin === 'microsoft'
          ? t('hub:foundryLocal.microsoftCatalog')
          : t('hub:foundryLocal.curated')}
      </span>
    )
  }
  return (
    <a
      href={`https://huggingface.co/${hubRepoId(model)}`}
      target="_blank"
      rel="noopener noreferrer"
      className="inline-flex h-9 shrink-0 items-center gap-1.5 rounded-full border border-border px-3 text-xs hover:bg-secondary"
    >
      <img
        src="/images/model-provider/huggingface.svg"
        alt=""
        className="size-4"
      />
      {t('hub:source.huggingFace')}
      <ExternalLink size={12} />
    </a>
  )
}

export type ModelDetailPanelProps = {
  model: CatalogModel
  /** The row's display name: the pick's title, the Foundry name or the repo's. */
  name: string
  /** Curated metadata when the row came from staff picks. */
  pickIcon?: string
  facts: HubModelFacts
  /** The Format value, when the row's differs from the facts' format. */
  formatLabel?: string
  /** A linked safetensors checkpoint no engine here serves: a note in place of download options. */
  unserved?: UnservedCheckpoint<ManagedEngine>
  /** Hugging Face's parameter count is on its way: the row's own, shown the same here. */
  paramsLoading?: boolean
  /** The Hugging Face card with the sizes and download options is on its way. */
  cardLoading?: boolean
  /** The row's engines this machine offers. */
  engines: readonly HubEngineId[]
  /** Memory budget in bytes; 0 hides the fit indicators. */
  budgetBytes: number
  liked: boolean
  onToggleLike: () => void
  onCollapse: () => void
  className?: string
}

/**
 * The open row of the Hub's local models table: the model's name with its
 * heart and source, what is known about it, and what can be downloaded — or,
 * for a linked checkpoint no engine here serves, what it runs on.
 *
 * Its facts are the row's, so opening a row changes no number. What is still
 * on its way (Hugging Face's parameter count, a feed row's card with sizes and
 * download options) shows as a placeholder of its size rather than appearing
 * later and moving the rest.
 */
export function ModelDetailPanel({
  model,
  name,
  pickIcon,
  facts,
  formatLabel = HUB_FORMAT_LABELS[facts.format],
  unserved,
  paramsLoading = false,
  cardLoading = false,
  engines,
  budgetBytes,
  liked,
  onToggleLike,
  onCollapse,
  className,
}: ModelDetailPanelProps) {
  const { t, i18n } = useTranslation()
  const foundry = foundryLocalOf(model)
  const unknown = t('hub:table.unknown')
  const pending = (width: string) => (
    <PendingValue className={cn('h-4', width)} />
  )
  const engineText = engines.map(hubEngineLabel).join(', ')
  const updated = formatTimeAgo(
    model.last_modified ?? model.created_at,
    i18n.language
  )

  // An engine's card too old, in that engine's words; otherwise what the model runs on.
  const unservedNote = ({ tooOld }: UnservedCheckpoint<ManagedEngine>) =>
    tooOld
      ? t(hubKey(tooOld.engine)('blocker.compute-capability-too-low'), {
          required: tooOld.required,
          actual: tooOld.actual,
        })
      : t('hub:safetensorsNeedsNvidia')

  const items: [string, ReactNode][] = [
    [
      t('hub:table.column.parameters'),
      facts.params ?? (paramsLoading ? pending('w-12') : unknown),
    ],
    [t('hub:table.column.format'), formatLabel],
    [t('hub:table.column.engines'), engineText || unknown],
    [
      t('hub:table.column.capabilities'),
      facts.capabilities.map((cap) => cap.label).join(', ') ||
        t('hub:table.notSpecified'),
    ],
    [
      t('hub:table.column.downloadSize'),
      facts.sizeText ?? (cardLoading ? pending('w-14') : unknown),
    ],
    [
      t('hub:table.column.thisDevice'),
      facts.fit ? (
        <FitBadge fit={facts.fit} className="px-1.5 py-0.5 text-[10px]" />
      ) : model.is_managed || foundry ? (
        t('hub:table.deviceInCard')
      ) : cardLoading ? (
        pending('w-16')
      ) : (
        unknown
      ),
    ],
  ]

  return (
    <div className={cn('min-w-0', className)} data-testid="model-detail-panel">
      <header className="flex flex-wrap items-center gap-2 p-4 pb-0">
        <button
          type="button"
          aria-expanded="true"
          aria-label={t('hub:table.collapse', { name })}
          onClick={onCollapse}
          className="flex min-w-0 flex-1 cursor-pointer items-center gap-2 text-left"
        >
          <ChevronDown size={14} className="shrink-0" />
          <ModelLogo
            author={model.developer}
            name={model.model_name}
            icon={pickIcon}
            className="size-8 shrink-0 rounded-md"
          />
          <span className="flex min-w-0 flex-col">
            <span className="min-w-0 break-words text-sm font-semibold">
              {name}
            </span>
            <span className="flex min-w-0 flex-wrap items-center gap-x-3 text-xs font-normal text-muted-foreground">
              <span className="min-w-0 truncate">
                {foundry ? foundry.model_id : hubRepoId(model)}
              </span>
              {!!model.downloads && model.downloads > 0 && (
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <IconDownload size={12} />
                  {formatDownloads(model.downloads)}
                </span>
              )}
              {!!model.likes && model.likes > 0 && (
                <span className="inline-flex items-center gap-1 tabular-nums">
                  <IconHeart size={12} />
                  {formatDownloads(model.likes)}
                </span>
              )}
              {updated && <span>{t('hub:updatedAgo', { ago: updated })}</span>}
            </span>
          </span>
        </button>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t(liked ? 'hub:table.unlike' : 'hub:table.like', {
            name,
          })}
          aria-pressed={liked}
          onClick={onToggleLike}
        >
          <Heart
            size={16}
            className={liked ? 'fill-rose-400 text-rose-400' : undefined}
          />
        </Button>
        <SourceLink model={model} />
      </header>
      <dl className="model-expanded-facts grid gap-3 p-4 text-xs">
        {items.map(([label, value]) => (
          <div key={label} className="min-w-0">
            <dt className="text-muted-foreground">{label}</dt>
            <dd className="mt-1 break-words font-medium">{value}</dd>
          </div>
        ))}
      </dl>
      <div className="p-4 pt-0">
        {cardLoading ? (
          // The download options' own frame, so the card does not grow when they land.
          <section
            data-testid="download-options-pending"
            className="rounded-lg border border-border bg-card p-4"
          >
            <h2 className="mb-3 text-sm font-medium">
              {t('hub:downloadOptions')}
            </h2>
            <div className="flex items-center justify-between gap-3">
              {pending('w-40')}
              <Skeleton className="h-9 w-28 rounded-full" />
            </div>
          </section>
        ) : unserved ? (
          <p
            data-testid="unserved-checkpoint"
            className="text-xs text-muted-foreground"
          >
            {unservedNote(unserved)}
          </p>
        ) : (
          <DownloadOptionsSelect model={model} budgetBytes={budgetBytes} />
        )}
      </div>
    </div>
  )
}
