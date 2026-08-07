import { IconDownload } from '@tabler/icons-react'
import { ModelLogo } from '@/containers/ModelLogo'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { modelDownloadSizeText } from '@/lib/hub-filters'
import { formatDownloads, modelFormat } from '@/lib/model-card'
import { extractModelName } from '@/lib/models'
import { cn } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'
import type { StaffPick } from '@/services/staff-picks-registry'

export type ModelListRowProps = {
  model: CatalogModel
  /** Curated metadata, when the row comes from the staff-picks manifest. */
  pick?: StaffPick
  selected?: boolean
  /** Long-tail Hugging Face hit: draw the neutral HF mark, not a letter. */
  fromHuggingFace?: boolean
  onSelect: () => void
}

/**
 * Compact list row for the Hub left column.
 *
 * Deliberately light: everything that needs a network round-trip or a size
 * calculation per quant lives in the detail panel, so scrolling a few hundred
 * search hits stays cheap.
 */
export function ModelListRow({
  model,
  pick,
  selected = false,
  fromHuggingFace = false,
  onSelect,
}: ModelListRowProps) {
  const { t } = useTranslation()
  const name =
    pick?.title || extractModelName(model.model_name) || model.model_name
  const summary =
    (pick?.description_key ? t(pick.description_key) : undefined) ||
    pick?.summary ||
    model.developer ||
    ''
  const sizeText = modelDownloadSizeText(model)
  const format = modelFormat(model)

  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-transparent p-2 text-left transition-colors hover:bg-accent',
        selected && 'border-border bg-accent'
      )}
    >
      <ModelLogo
        author={model.developer}
        name={model.model_name}
        icon={pick?.icon}
        fallback={fromHuggingFace ? 'huggingface' : 'letter'}
        className="size-9 rounded-lg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {name}
          </span>
          <span className="shrink-0 rounded-[5px] border border-border px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-muted-foreground">
            {format}
          </span>
        </span>
        {summary && (
          <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
            {summary}
          </span>
        )}
        <span className="mt-1 flex items-center gap-2 text-[11px] text-muted-foreground">
          {sizeText && <span className="whitespace-nowrap">{sizeText}</span>}
          {!!model.downloads && model.downloads > 0 && (
            <span className="inline-flex items-center gap-1 whitespace-nowrap">
              <IconDownload size={11} />
              {formatDownloads(model.downloads)}
            </span>
          )}
        </span>
      </span>
    </button>
  )
}
