import { useMemo, useState } from 'react'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { MlxModelDownloadAction } from '@/containers/MlxModelDownloadAction'
import { ModelDownloadAction } from '@/containers/ModelDownloadAction'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  estimateFit,
  HARDWARE_FIT,
  parseFileSizeToBytes,
  pickDownloadQuant,
  quantLabel,
  type HardwareFit,
} from '@/lib/model-card'
import { getMlxTotalFileSize, getTotalDownloadFileSize } from '@/lib/models'
import { cn } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'

const FIT_DOT_CLASS: Record<HardwareFit, string> = {
  ok: 'bg-[#22b264]',
  maybe: 'bg-[#e0991f]',
  no: 'bg-[#e0564e]',
}

function FitDot({ fit }: { fit: HardwareFit }) {
  return (
    <Tooltip>
      <TooltipTrigger asChild>
        <span
          aria-label={HARDWARE_FIT[fit].label}
          className={cn('size-2 shrink-0 rounded-full', FIT_DOT_CLASS[fit])}
        />
      </TooltipTrigger>
      <TooltipContent>
        <p>{HARDWARE_FIT[fit].tip}</p>
      </TooltipContent>
    </Tooltip>
  )
}

export type DownloadOptionsSelectProps = {
  model: CatalogModel
  /** Memory budget in bytes; 0 hides the fit indicators. */
  budgetBytes: number
}

/**
 * Collapsed quant selector with the LM Studio shape: the chosen variant plus a
 * disclosure listing every quant with its size and hardware-fit dot.
 *
 * MLX repos ship as one safetensors set rather than a list of quants, so they
 * skip the selector entirely and render the MLX download action directly.
 */
export function DownloadOptionsSelect({
  model,
  budgetBytes,
}: DownloadOptionsSelectProps) {
  const { t } = useTranslation()
  const [expanded, setExpanded] = useState(false)
  const [selectedId, setSelectedId] = useState<string | null>(null)

  const defaultQuant = useMemo(
    () => pickDownloadQuant(model, budgetBytes),
    [model, budgetBytes]
  )
  const sortedQuants = useMemo(
    () =>
      [...(model.quants ?? [])].sort((left, right) => {
        const leftSize = parseFileSizeToBytes(
          getTotalDownloadFileSize(model, left)
        )
        const rightSize = parseFileSizeToBytes(
          getTotalDownloadFileSize(model, right)
        )

        if (leftSize === undefined && rightSize === undefined) return 0
        if (leftSize === undefined) return 1
        if (rightSize === undefined) return -1
        return leftSize - rightSize
      }),
    [model]
  )
  const selected =
    model.quants?.find((quant) => quant.model_id === selectedId) ?? defaultQuant

  const fitKnown = budgetBytes > 0

  if (model.is_mlx) {
    const sizeText = getMlxTotalFileSize(model)
    const fit = estimateFit(parseFileSizeToBytes(sizeText), budgetBytes)
    return (
      <section className="rounded-lg border border-border bg-card p-4">
        <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {fitKnown && <FitDot fit={fit} />}
            <span className="rounded-[5px] border border-slate-300 bg-slate-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
              MLX
            </span>
            {sizeText && (
              <span className="truncate text-xs text-muted-foreground">
                {sizeText}
              </span>
            )}
          </div>
          <MlxModelDownloadAction model={model} />
        </div>
      </section>
    )
  }

  if (!model.quants?.length || !selected) return null

  const selectedSize = getTotalDownloadFileSize(model, selected)
  const selectedFit = estimateFit(
    parseFileSizeToBytes(selectedSize),
    budgetBytes
  )

  return (
    <section className="rounded-lg border border-border bg-card p-4">
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/40 px-2 py-2 text-left hover:bg-muted/60"
        >
          {fitKnown && <FitDot fit={selectedFit} />}
          <span className="shrink-0 rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
            {quantLabel(selected.model_id)}
          </span>
          {selectedSize && (
            <span className="truncate text-xs text-muted-foreground">
              {selectedSize}
            </span>
          )}
          {expanded ? (
            <IconChevronUp size={15} className="ml-auto text-muted-foreground" />
          ) : (
            <IconChevronDown
              size={15}
              className="ml-auto text-muted-foreground"
            />
          )}
        </button>

        {selectedFit === 'no' ? (
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="shrink-0 cursor-not-allowed">
                <Button
                  variant="outline"
                  size="sm"
                  disabled
                  className="pointer-events-none font-semibold"
                >
                  {t('hub:download')}
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              <p>{HARDWARE_FIT.no.tip}</p>
            </TooltipContent>
          </Tooltip>
        ) : (
          <ModelDownloadAction variant={selected} model={model} asButton />
        )}
      </div>

      {expanded && (
        <ul className="mt-3 border-t border-border pt-2">
          {sortedQuants.map((quant) => {
            const sizeText = getTotalDownloadFileSize(model, quant)
            const fit = estimateFit(parseFileSizeToBytes(sizeText), budgetBytes)
            return (
              <li key={quant.model_id}>
                <button
                  type="button"
                  onClick={() => {
                    setSelectedId(quant.model_id)
                    setExpanded(false)
                  }}
                  aria-current={
                    quant.model_id === selected.model_id ? 'true' : undefined
                  }
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted/40',
                    quant.model_id === selected.model_id && 'bg-muted/60'
                  )}
                >
                  {fitKnown && <FitDot fit={fit} />}
                  <span className="rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
                    {quantLabel(quant.model_id)}
                  </span>
                  {sizeText && (
                    <span className="ml-auto whitespace-nowrap text-xs text-muted-foreground">
                      {sizeText}
                    </span>
                  )}
                </button>
              </li>
            )
          })}
        </ul>
      )}
    </section>
  )
}
