import { useEffect, useMemo, type ReactNode } from 'react'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import HeaderPage from '@/containers/HeaderPage'
import { ModelLogo } from '@/containers/ModelLogo'
import { EmbeddingModelDetailPanel } from '@/containers/hub/EmbeddingModelDetailPanel'
import { HubNoResults, HubSearchInput } from '@/containers/hub/HubSearch'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { filterEmbeddingModels } from '@/lib/hub-media'
import { embeddingIconKey } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { EmbeddingCatalogModel } from '@/services/embedding-catalog-registry'
import { useEmbeddingStore } from '@/stores/embedding-store'

export type EmbeddingHubProps = {
  /** The model type picker, painted above the list. */
  categoryTabs?: ReactNode
  query: string
  onQueryChange: (query: string) => void
  /** Catalog id named by the URL. */
  selectedModelId: string | null
  onSelectModel: (modelId: string, options?: { replace?: boolean }) => void
}

const repoOwner = (repo: string) => repo.split('/')[0]

/** The catalog's default first, the rest in catalog order. */
const defaultFirst = (models: EmbeddingCatalogModel[]) => [
  ...models.filter((model) => model.default),
  ...models.filter((model) => !model.default),
]

function EmbeddingModelRow({
  model,
  installed,
  selected,
  onSelect,
}: {
  model: EmbeddingCatalogModel
  installed: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-current={selected ? 'true' : undefined}
      className={cn(
        'flex w-full items-center gap-3 rounded-lg border border-transparent px-2 py-3 text-left transition-colors hover:bg-accent',
        selected && 'border-border bg-accent'
      )}
    >
      <ModelLogo
        icon={embeddingIconKey(model)}
        name={model.name}
        author={repoOwner(model.repo)}
        className="size-9 rounded-lg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {model.name}
          </span>
          {model.modalities
            .filter((modality) => modality !== 'text')
            .map((modality) => (
              <span
                key={modality}
                className="shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
                data-testid={`embedding-modality-${model.id}-${modality}`}
              >
                {t(`hub:embeddingModality.${modality}`)}
              </span>
            ))}
          {installed && (
            <IconCircleCheckFilled
              size={16}
              className="shrink-0 text-emerald-600 dark:text-emerald-400"
              aria-label={t('hub:downloaded')}
            />
          )}
        </span>
        <span className="mt-0.5 line-clamp-1 text-xs text-muted-foreground">
          {model.repo}
        </span>
      </span>
    </button>
  )
}

/**
 * The Hub's Embedding category: the curated embedding catalog in the Hub's
 * two-column layout, each model tagged with what it reads beyond text.
 * Downloaded models come first, the catalog's default leads each group; they
 * are started from the llama.cpp provider page, where Open leads. The
 * category shows only where stock llama.cpp has a build.
 */
export function EmbeddingHub({
  categoryTabs,
  query,
  onQueryChange,
  selectedModelId,
  onSelectModel,
}: EmbeddingHubProps) {
  const { t } = useTranslation()
  const catalog = useEmbeddingStore((s) => s.catalog)
  const installed = useEmbeddingStore((s) => s.installed)

  useEffect(() => useEmbeddingStore.getState().bind(), [])

  const sections = useMemo(() => {
    const shown = defaultFirst(filterEmbeddingModels(catalog.models, query))
    return {
      installed: shown.filter((model) => installed[model.id]),
      available: shown.filter((model) => !installed[model.id]),
    }
  }, [catalog.models, query, installed])

  // Resolved against the whole catalog: a search that hides the open model
  // should not blank the panel beside it.
  const selectedModel =
    catalog.models.find((model) => model.id === selectedModelId) ?? null
  const firstModelId = (sections.installed[0] ?? sections.available[0])?.id

  useEffect(() => {
    if (selectedModel || !firstModelId) return
    onSelectModel(firstModelId, { replace: true })
  }, [selectedModel, firstModelId, onSelectModel])

  const isEmpty =
    sections.installed.length === 0 && sections.available.length === 0

  const renderSection = (
    label: string,
    items: EmbeddingCatalogModel[],
    downloaded: boolean
  ) =>
    items.length > 0 && (
      <section>
        <h2 className="px-2 pb-2 pt-4 text-base font-semibold text-foreground">
          {label}
        </h2>
        <div className="flex flex-col gap-1">
          {items.map((model) => (
            <EmbeddingModelRow
              key={model.id}
              model={model}
              installed={downloaded}
              selected={model.id === selectedModel?.id}
              onSelect={() => onSelectModel(model.id)}
            />
          ))}
        </div>
      </section>
    )

  return (
    <div
      className="grid h-svh w-full grid-cols-[minmax(320px,420px)_1fr] grid-rows-[auto_minmax(0,1fr)]"
      data-testid="embedding-hub"
    >
      <HeaderPage>
        <div
          className={cn(
            'relative z-20 flex h-10 w-full items-center gap-2 py-3 pr-3',
            !IS_MACOS && !IS_WINDOWS && 'pr-30'
          )}
          {...(IS_WINDOWS || IS_MACOS
            ? { 'data-tauri-drag-region': true }
            : {})}
        >
          <HubSearchInput
            value={query}
            onChange={onQueryChange}
            placeholder={t('hub:searchEmbeddingPlaceholder')}
          />
        </div>
      </HeaderPage>

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col border-r border-border">
        {categoryTabs && (
          <div className="border-b border-border p-3">{categoryTabs}</div>
        )}

        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {isEmpty ? (
            <HubNoResults
              message={t('hub:noModels')}
              onClearSearch={
                query.length > 0 ? () => onQueryChange('') : undefined
              }
            />
          ) : (
            <>
              {renderSection(t('hub:downloaded'), sections.installed, true)}
              {renderSection(t('hub:available'), sections.available, false)}
            </>
          )}
        </div>
      </div>

      <div className="col-start-2 row-span-2 row-start-1 min-h-0 min-w-0 overflow-y-auto">
        <EmbeddingModelDetailPanel model={selectedModel} />
      </div>
    </div>
  )
}
