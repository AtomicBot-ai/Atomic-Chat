import { Fragment, memo, useEffect, useMemo, useRef, useState } from 'react'
import { ArrowUpDown, ChevronRight, Heart } from 'lucide-react'
import { ModelLogo } from '@/containers/ModelLogo'
import { FitBadge } from '@/containers/hub/FitBadge'
import { ModelDetailPanel } from '@/containers/hub/ModelDetailPanel'
import { useModelLikes } from '@/hooks/useModelLikes'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { HUB_FORMAT_LABELS } from '@/lib/hub-filters'
import { hubEngineLabel, type HubEngineId } from '@/lib/hub-model-engines'
import {
  hubModelFacts,
  hubModelName,
  hubSortValue,
  type HubModelFacts,
  type HubSortableColumn,
} from '@/lib/hub-model-facts'
import { foundryLocalOf } from '@/lib/foundry-local/hub'
import type { ModelFormat } from '@/lib/model-card'
import { cn, formatBytes } from '@/lib/utils'
import type { CatalogModel } from '@/services/models/types'
import type { StaffPick } from '@/services/staff-picks-registry'
import './hub.css'

/** A row of the table, plus the provenance it needs to render. */
export type LocalModelTableItem = {
  model: CatalogModel
  pick?: StaffPick
  fromHuggingFace?: boolean
  /**
   * The section the row belongs to (Recommended, More from Hugging Face, a curated list…). A
   * heading row is drawn wherever the section changes.
   */
  section?: string
}

/** How many rows before the end of the list the next page is asked for. */
const PREFETCH_ROWS = 8

type Column = {
  key: string
  label: string
  sort?: HubSortableColumn
}

const COLUMNS = [
  { key: 'model', sort: 'model' },
  { key: 'parameters', sort: 'parameters' },
  { key: 'format', sort: 'format' },
  { key: 'context', sort: 'context' },
  { key: 'capabilities' },
  { key: 'downloadSize', sort: 'downloadSize' },
  { key: 'estRam', sort: 'estRam' },
  { key: 'thisDevice' },
  { key: 'uncensored' },
  { key: 'engines', sort: 'engines' },
] as const satisfies readonly { key: string; sort?: HubSortableColumn }[]

export type LocalModelTableProps = {
  items: readonly LocalModelTableItem[]
  /** The open row's model id, or `null` when every row is closed. */
  selected: string | null
  /** Open a row, or close the open one (`null`). */
  onSelect: (modelId: string | null) => void
  /** Memory budget in bytes; 0 leaves the fit unknown. */
  budgetBytes: number
  /** The format the Hub lists: a managed checkpoint reads as it. */
  format?: ModelFormat
  /** The engines this machine offers; a row names only these. */
  availableEngines: ReadonlySet<HubEngineId>
  /** The model ids of the rows on screen, in list order, whenever they change. */
  onVisibleRowsChange?: (modelIds: string[]) => void
  /**
   * Whether the end of the list (its last few rows) is on screen. Reported `false` the moment
   * the rows change, before anything is measured, so a parent never pages on a stale reading.
   */
  onEndVisibleChange?: (visible: boolean) => void
}

type Row = LocalModelTableItem & {
  name: string
  facts: HubModelFacts
  engines: HubEngineId[]
}

/**
 * The Hub's local models: one row per model with what the listing says about it, sortable by
 * column (unknown values last either way), and one row open at a time with its facts and
 * download options in place of its summary.
 *
 * Every row is rendered. Which rows are on screen is read with an `IntersectionObserver`: the
 * rows the parent fetches sizes for, and the end of the list, where it asks for the next page.
 */
export function LocalModelTable({
  items,
  selected,
  onSelect,
  budgetBytes,
  format,
  availableEngines,
  onVisibleRowsChange,
  onEndVisibleChange,
}: LocalModelTableProps) {
  const { t } = useTranslation()
  const liked = useModelLikes((state) => state.liked)
  const toggleLike = useModelLikes((state) => state.toggle)
  const [sort, setSort] = useState<{
    column: HubSortableColumn
    direction: 1 | -1
  } | null>(null)
  const bodyRef = useRef<HTMLTableSectionElement>(null)
  const onVisibleRowsChangeRef = useRef(onVisibleRowsChange)
  const onEndVisibleChangeRef = useRef(onEndVisibleChange)
  onVisibleRowsChangeRef.current = onVisibleRowsChange
  onEndVisibleChangeRef.current = onEndVisibleChange

  const columns: Column[] = COLUMNS.map((column) => ({
    ...column,
    label: t(`hub:table.column.${column.key}`),
  }))

  const rows = useMemo<Row[]>(() => {
    const built = items.map((item) => {
      const facts = hubModelFacts(item.model, {
        format,
        budgetBytes,
        categories: item.pick?.categories,
      })
      return {
        ...item,
        name: hubModelName(item.model, item.pick),
        facts,
        engines: facts.engines.filter((id) => availableEngines.has(id)),
      }
    })
    if (!sort) return built
    const value = (row: Row) =>
      hubSortValue(row.name, row.facts, sort.column, hubEngineLabel)
    // A sorted list is one list: its sections would only interleave.
    return [...built]
      .sort((left, right) => {
        const a = value(left)
        const b = value(right)
        if (a === undefined) return b === undefined ? 0 : 1
        if (b === undefined) return -1
        const order =
          typeof a === 'number' && typeof b === 'number'
            ? a - b
            : String(a).localeCompare(String(b))
        return order * sort.direction
      })
      .map((row) => ({ ...row, section: undefined }))
  }, [items, format, budgetBytes, availableEngines, sort])

  // The rows on screen are measured again only when the rows themselves change
  // (a page arrives, a sort, a row opens), not when a size fills in.
  const rowIds = useMemo(
    () => rows.map((row) => row.model.model_name).join('\n'),
    [rows]
  )
  useEffect(() => {
    // Whatever was measured belongs to the rows before this change.
    onEndVisibleChangeRef.current?.(false)
    const body = bodyRef.current
    if (!body || typeof IntersectionObserver === 'undefined') return
    const elements = Array.from(
      body.querySelectorAll<HTMLElement>('[data-model-row]')
    )
    if (elements.length === 0) return
    const nearEnd = elements[Math.max(0, elements.length - PREFETCH_ROWS)]
    const visible = new Set<HTMLElement>()
    let frame = 0
    const flush = () => {
      frame = 0
      onVisibleRowsChangeRef.current?.(
        elements
          .filter((element) => visible.has(element))
          .map((element) => element.dataset.modelRow ?? '')
      )
    }
    const observer = new IntersectionObserver((entries) => {
      for (const entry of entries) {
        const element = entry.target as HTMLElement
        if (entry.isIntersecting) visible.add(element)
        else visible.delete(element)
        if (element === nearEnd) {
          onEndVisibleChangeRef.current?.(entry.isIntersecting)
        }
      }
      if (!frame) frame = requestAnimationFrame(flush)
    })
    for (const element of elements) observer.observe(element)
    return () => {
      observer.disconnect()
      if (frame) cancelAnimationFrame(frame)
    }
  }, [rowIds, selected])

  return (
    <div className="local-models-responsive w-full min-w-0">
      <div className="mb-2 flex items-center justify-between gap-3 text-xs text-muted-foreground">
        <span>{t('hub:table.count', { count: items.length })}</span>
        {sort && (
          <button
            type="button"
            className="cursor-pointer hover:text-foreground"
            onClick={() => setSort(null)}
          >
            {t('hub:table.resetSort')}
          </button>
        )}
      </div>
      <div className="local-model-table-frame rounded-lg border border-border">
        <table
          className="local-model-table w-full text-left text-xs"
          aria-label={t('hub:table.label')}
        >
          <thead className="bg-secondary/40 text-muted-foreground">
            <tr>
              {columns.map((column) => (
                <th
                  key={column.key}
                  scope="col"
                  data-column={column.key}
                  aria-sort={
                    sort && sort.column === column.sort
                      ? sort.direction === 1
                        ? 'ascending'
                        : 'descending'
                      : undefined
                  }
                  className="px-2 py-3 font-medium"
                >
                  {column.sort ? (
                    <button
                      type="button"
                      aria-label={t('hub:table.sortBy', {
                        column: column.label,
                      })}
                      onClick={() => {
                        const key = column.sort as HubSortableColumn
                        setSort((current) => ({
                          column: key,
                          direction:
                            current?.column === key
                              ? current.direction === 1
                                ? -1
                                : 1
                              : 1,
                        }))
                      }}
                      // Inline, so the arrow wraps with the last word.
                      className="max-w-full cursor-pointer text-left hover:text-foreground"
                    >
                      {column.label}
                      <ArrowUpDown
                        size={11}
                        className={cn(
                          'ml-1 inline-block align-[-1px]',
                          sort?.column === column.sort
                            ? 'text-foreground'
                            : 'opacity-40'
                        )}
                      />
                    </button>
                  ) : (
                    column.label
                  )}
                </th>
              ))}
            </tr>
          </thead>
          <tbody ref={bodyRef}>
            {rows.map((row, index) => {
              const id = row.model.model_name
              const heading =
                row.section &&
                (index === 0 || rows[index - 1].section !== row.section)
              const isLiked = liked.includes(id)
              return (
                <Fragment key={id}>
                  {heading && (
                    <tr className="local-model-group border-t border-border first:border-t-0">
                      <th
                        colSpan={10}
                        scope="colgroup"
                        className="px-3 pb-2 pt-4"
                      >
                        <h2 className="text-base font-semibold text-foreground">
                          {row.section}
                        </h2>
                      </th>
                    </tr>
                  )}
                  {selected === id ? (
                    <tr data-model-row={id} className="local-model-expanded">
                      <td
                        colSpan={10}
                        className="border-t border-border bg-secondary/10"
                      >
                        <ModelDetailPanel
                          model={row.model}
                          name={row.name}
                          pickIcon={row.pick?.icon}
                          facts={row.facts}
                          engines={row.engines}
                          budgetBytes={budgetBytes}
                          liked={isLiked}
                          onToggleLike={() => toggleLike(id)}
                          onCollapse={() => onSelect(null)}
                        />
                      </td>
                    </tr>
                  ) : (
                    <SummaryRow
                      row={row}
                      liked={isLiked}
                      onToggleLike={toggleLike}
                      onExpand={onSelect}
                    />
                  )}
                </Fragment>
              )
            })}
          </tbody>
        </table>
      </div>
      <p className="mt-2 text-[11px] text-muted-foreground">
        {t('hub:table.footnote')}
      </p>
    </div>
  )
}

type SummaryRowProps = {
  row: Row
  liked: boolean
  onToggleLike: (id: string) => void
  onExpand: (id: string) => void
}

const SummaryRow = memo(function SummaryRow({
  row,
  liked,
  onToggleLike,
  onExpand,
}: SummaryRowProps) {
  const { t } = useTranslation()
  const { model, pick, fromHuggingFace, name, facts, engines } = row
  const id = model.model_name
  const foundry = foundryLocalOf(model)
  const unknown = t('hub:table.unknown')
  const engineText = engines.map(hubEngineLabel).join(', ')
  const formatLabel = HUB_FORMAT_LABELS[facts.format]
  const verdictInCard = model.is_managed || !!foundry

  return (
    <tr
      data-model-row={id}
      data-source={fromHuggingFace ? 'huggingface' : 'recommended'}
      className="local-model-summary border-t border-border hover:bg-secondary/30"
    >
      <td className="p-2">
        <button
          type="button"
          aria-expanded={false}
          aria-label={t('hub:table.expand', { name })}
          onClick={() => onExpand(id)}
          className="local-model-toggle flex w-full min-w-0 cursor-pointer items-center gap-2 py-2 text-left"
        >
          <ChevronRight size={13} />
          <ModelLogo
            author={model.developer}
            name={model.model_name}
            icon={pick?.icon}
            fallback={fromHuggingFace ? 'huggingface' : 'letter'}
            className="model-row-logo size-7 shrink-0 rounded-md"
          />
          <span className="min-w-0 flex-1 font-medium">
            {name}
            {fromHuggingFace && (
              <img
                src="/images/model-provider/huggingface.svg"
                alt={t('hub:fromHuggingFace')}
                title={t('hub:fromHuggingFace')}
                className="ml-1 inline-block size-3.5"
              />
            )}
            {foundry?.origin === 'microsoft' && (
              <span className="mt-1 block text-[10px] font-normal text-muted-foreground">
                {t('hub:foundryLocal.microsoftCatalog')}
              </span>
            )}
            <span className="model-inline-meta mt-1 text-[10px] font-normal text-muted-foreground">
              {facts.params ?? '—'} · {formatLabel}
            </span>
            <span className="model-inline-engines mt-1 text-[10px] font-normal text-muted-foreground">
              {engineText || unknown}
            </span>
          </span>
        </button>
        <button
          type="button"
          aria-label={t(liked ? 'hub:table.unlike' : 'hub:table.like', {
            name,
          })}
          aria-pressed={liked}
          onClick={() => onToggleLike(id)}
          className="model-like cursor-pointer rounded-md p-1.5 text-muted-foreground hover:text-rose-400"
        >
          <Heart
            size={14}
            className={liked ? 'fill-rose-400 text-rose-400' : undefined}
          />
        </button>
      </td>
      <td className="px-2">{facts.params ?? '—'}</td>
      <td className="px-2">{formatLabel}</td>
      <td className="px-2">{facts.context ?? unknown}</td>
      <td className="px-2">
        <div className="flex min-w-0 flex-wrap gap-1">
          {facts.capabilities.map((capability) => (
            <span
              key={capability.label}
              className="rounded border border-border px-1 py-0.5 text-[10px]"
            >
              {capability.label}
            </span>
          ))}
        </div>
      </td>
      <td className="px-2 tabular-nums" title={t('hub:table.sizeHint')}>
        {facts.sizeText ?? unknown}
      </td>
      <td className="px-2 tabular-nums" title={t('hub:table.ramHint')}>
        {facts.sizeBytes ? `≈ ${formatBytes(facts.sizeBytes)}` : unknown}
      </td>
      <td
        className={cn('px-2', !facts.fit && 'text-muted-foreground')}
        title={verdictInCard ? t('hub:table.deviceInCardHint') : undefined}
      >
        {facts.fit ? (
          <FitBadge fit={facts.fit} className="px-1.5 py-0.5 text-[10px]" />
        ) : verdictInCard ? (
          t('hub:table.deviceInCard')
        ) : (
          unknown
        )}
      </td>
      <td className="px-2">
        {facts.uncensored
          ? t('hub:table.uncensoredYes')
          : t('hub:table.uncensoredNo')}
      </td>
      <td className="px-2 text-[11px]" title={engineText || undefined}>
        <span>{engines[0] ? hubEngineLabel(engines[0]) : unknown}</span>
        {engines.length > 1 && (
          <span className="ml-1 text-muted-foreground" aria-label={engineText}>
            +{engines.length - 1}
          </span>
        )}
      </td>
    </tr>
  )
}, sameSummary)

/**
 * Rows are rebuilt whenever the list changes (a size arriving for one row
 * rebuilds them all); a summary repaints only when what it shows did.
 */
function sameSummary(
  previous: SummaryRowProps,
  next: SummaryRowProps
): boolean {
  const a = previous.row
  const b = next.row
  return (
    a.model === b.model &&
    a.pick === b.pick &&
    a.fromHuggingFace === b.fromHuggingFace &&
    a.facts.format === b.facts.format &&
    a.facts.fit === b.facts.fit &&
    a.engines.join() === b.engines.join() &&
    previous.liked === next.liked &&
    previous.onToggleLike === next.onToggleLike &&
    previous.onExpand === next.onExpand
  )
}
