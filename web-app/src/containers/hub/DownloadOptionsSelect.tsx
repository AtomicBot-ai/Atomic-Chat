import { useMemo, useRef, useState } from 'react'
import { IconChevronDown, IconChevronUp } from '@tabler/icons-react'
import { MlxModelDownloadAction } from '@/containers/MlxModelDownloadAction'
import { ModelDownloadAction } from '@/containers/ModelDownloadAction'
import { FitBadge } from '@/containers/hub/FitBadge'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  findInstalledLocalModel,
  LLAMACPP_PROVIDERS,
  quantModelIds,
} from '@/lib/hub-installed'
import {
  estimateFit,
  parseFileSizeToBytes,
  pickDownloadQuant,
  quantLabel,
} from '@/lib/model-card'
import { getMlxTotalFileSize, getTotalDownloadFileSize } from '@/lib/models'
import { cn } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'

export type DownloadOptionsSelectProps = {
  model: CatalogModel
  /** Memory budget in bytes; 0 hides the fit indicators. */
  budgetBytes: number
}

/**
 * Collapsed quant selector with the LM Studio shape: the chosen variant plus a
 * disclosure listing every quant with its size and the same hardware-fit badge
 * used by Welcome and the recommendation cards.
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
  const sectionRef = useRef<HTMLElement>(null)

  const returnToDownloadAction = () => {
    requestAnimationFrame(() => {
      sectionRef.current?.scrollIntoView({
        behavior: window.matchMedia('(prefers-reduced-motion: reduce)').matches
          ? 'auto'
          : 'smooth',
        block: 'start',
      })
    })
  }

  const defaultQuant = useMemo(
    () => pickDownloadQuant(model, budgetBytes),
    [model, budgetBytes]
  )
  // A repo whose Q8 is on disk should open on that quant, not on the one the
  // device would download — otherwise "New chat" and the delete button hide
  // behind the disclosure.
  const providers = useModelProvider((state) => state.providers)
  const installedQuant = useMemo(
    () =>
      (model.quants ?? []).find((quant) =>
        findInstalledLocalModel(
          providers,
          quantModelIds(model, quant.model_id),
          LLAMACPP_PROVIDERS
        )
      ),
    [model, providers]
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
    model.quants?.find((quant) => quant.model_id === selectedId) ??
    installedQuant ??
    defaultQuant

  const fitKnown = budgetBytes > 0

  if (model.is_mlx) {
    const sizeText = getMlxTotalFileSize(model)
    const fit = estimateFit(parseFileSizeToBytes(sizeText), budgetBytes)
    return (
      <section
        ref={sectionRef}
        className="scroll-mt-4 rounded-lg border border-border bg-card p-4"
      >
        <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>
        <div className="flex items-center justify-between gap-3">
          <div className="flex min-w-0 items-center gap-2">
            {fitKnown && (
              <FitBadge fit={fit} className="px-1.5 py-0.5 text-[10px]" />
            )}
            <span className="rounded-[5px] border border-slate-300 bg-slate-100 px-1.5 py-px text-[10px] font-bold uppercase tracking-wider text-slate-700 dark:border-slate-700 dark:bg-slate-900/60 dark:text-slate-200">
              MLX
            </span>
            {sizeText && (
              <span className="truncate text-xs text-muted-foreground">
                {sizeText}
              </span>
            )}
          </div>
          <MlxModelDownloadAction
            model={model}
            deletable
            warnTooLarge={fit === 'no'}
          />
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
    <section
      ref={sectionRef}
      className="scroll-mt-4 rounded-lg border border-border bg-card p-4"
    >
      <h2 className="mb-3 text-sm font-medium">{t('hub:downloadOptions')}</h2>

      <div className="flex items-center justify-between gap-3">
        <button
          type="button"
          onClick={() => setExpanded((prev) => !prev)}
          aria-expanded={expanded}
          className="flex min-w-0 flex-1 items-center gap-2 rounded-md bg-muted/40 px-2 py-2 text-left hover:bg-muted/60"
        >
          {fitKnown && (
            <FitBadge
              fit={selectedFit}
              className="px-1.5 py-0.5 text-[10px]"
            />
          )}
          <span className="shrink-0 rounded-[5px] bg-secondary px-[7px] py-0.5 font-mono text-[11px] font-semibold text-muted-foreground">
            {quantLabel(selected.model_id)}
          </span>
          {selectedSize && (
            <span className="truncate text-xs text-muted-foreground">
              {selectedSize}
            </span>
          )}
          {expanded ? (
            <IconChevronUp
              size={15}
              className="ml-auto text-muted-foreground"
            />
          ) : (
            <IconChevronDown
              size={15}
              className="ml-auto text-muted-foreground"
            />
          )}
        </button>

        {/* A quant the estimate calls too large still downloads, past a
            warning: the estimate is size against memory, not a measurement.
            An installed quant never warns — its button is "New chat". */}
        <ModelDownloadAction
          variant={selected}
          model={model}
          asButton
          deletable
          warnTooLarge={selectedFit === 'no'}
        />
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
                    returnToDownloadAction()
                  }}
                  aria-current={
                    quant.model_id === selected.model_id ? 'true' : undefined
                  }
                  className={cn(
                    'flex w-full items-center gap-2.5 rounded-md px-2 py-2 text-left hover:bg-muted/40',
                    quant.model_id === selected.model_id && 'bg-muted/60'
                  )}
                >
                  {fitKnown && (
                    <FitBadge
                      fit={fit}
                      className="px-1.5 py-0.5 text-[10px]"
                    />
                  )}
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
