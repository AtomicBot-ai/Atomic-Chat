import { useEffect, useMemo, type ReactNode } from 'react'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import { ModelLogo } from '@/containers/ModelLogo'
import { DecisionModelDetailPanel } from '@/containers/hub/DecisionModelDetailPanel'
import { HubNoResults } from '@/containers/hub/HubSearch'
import { HubSearchToolbar } from '@/containers/hub/HubSearchToolbar'
import { useHardware } from '@/hooks/useHardware'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { DECISION_ENGINE_UI } from '@/lib/decision/engine'
import { isDecisionHostSupported } from '@/lib/decision/platform'
import { filterDecisionModels } from '@/lib/hub-media'
import { decisionIconKey } from '@/lib/model-logo'
import { cn } from '@/lib/utils'
import type { DecisionCatalogModel } from '@/services/decision-catalog-registry'
import { useDecisionStore } from '@/stores/decision-store'

export type DecisionHubProps = {
  /** The model type picker, first in the toolbar. */
  categoryTabs?: ReactNode
  query: string
  onQueryChange: (query: string) => void
  /** Catalog id of the open model, named by the URL. */
  selectedModelId: string | null
  /** Open a model, or close the open one (`null`). */
  onSelectModel: (modelId: string | null) => void
}

const repoOwner = (repo: string) => repo.split('/')[0]

function DecisionModelRow({
  model,
  installed,
  selected,
  onSelect,
}: {
  model: DecisionCatalogModel
  installed: boolean
  selected: boolean
  onSelect: () => void
}) {
  const { t } = useTranslation()
  return (
    <button
      type="button"
      onClick={onSelect}
      aria-expanded={selected}
      className={cn(
        'flex w-full cursor-pointer items-center gap-3 rounded-lg px-2 py-3 text-left transition-colors hover:bg-accent',
        selected && 'rounded-b-none'
      )}
    >
      <ModelLogo
        icon={decisionIconKey(model)}
        name={model.name}
        author={repoOwner(model.repo)}
        className="size-9 rounded-lg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {model.name}
          </span>
          <span
            className="shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            data-testid={`decision-engine-${model.id}`}
          >
            {DECISION_ENGINE_UI[model.engine].name}
          </span>
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
 * The Hub's Decision category: the curated decision catalog, one row per
 * model opening its details below it, each tagged with the engine that runs it.
 * Downloaded models come first; they are started from that engine's provider
 * page (llama.cpp TurboQuant, or llama.cpp), where Open leads. A model whose
 * engine has no build for this machine is not listed.
 */
export function DecisionHub({
  categoryTabs,
  query,
  onQueryChange,
  selectedModelId,
  onSelectModel,
}: DecisionHubProps) {
  const { t } = useTranslation()
  const catalog = useDecisionStore((s) => s.catalog)
  const installed = useDecisionStore((s) => s.installed)
  const cpuArch = useHardware((s) => s.hardwareData.cpu.arch)

  useEffect(() => useDecisionStore.getState().bind(), [])

  const runnable = useMemo(
    () =>
      catalog.models.filter((model) =>
        isDecisionHostSupported(cpuArch, model.engine)
      ),
    [catalog.models, cpuArch]
  )

  const sections = useMemo(() => {
    const shown = filterDecisionModels(runnable, query)
    return {
      installed: shown.filter((model) => installed[model.id]),
      available: shown.filter((model) => !installed[model.id]),
    }
  }, [runnable, query, installed])

  const isEmpty =
    sections.installed.length === 0 && sections.available.length === 0

  const renderSection = (
    label: string,
    items: DecisionCatalogModel[],
    downloaded: boolean
  ) =>
    items.length > 0 && (
      <section>
        <h2 className="px-2 pb-2 pt-4 text-base font-semibold text-foreground">
          {label}
        </h2>
        <div className="flex flex-col gap-1">
          {items.map((model) => {
            const open = model.id === selectedModelId
            return (
              <div key={model.id} className="rounded-lg border border-border">
                <DecisionModelRow
                  model={model}
                  installed={downloaded}
                  selected={open}
                  onSelect={() => onSelectModel(open ? null : model.id)}
                />
                {open && <DecisionModelDetailPanel model={model} />}
              </div>
            )
          })}
        </div>
      </section>
    )

  return (
    <div
      className="grid h-svh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]"
      data-testid="decision-hub"
    >
      <HubSearchToolbar
        modelType={categoryTabs}
        value={query}
        onChange={onQueryChange}
        placeholder={t('hub:searchDecisionPlaceholder')}
      />

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col">
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
    </div>
  )
}
