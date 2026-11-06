import { useEffect, useMemo, type ReactNode } from 'react'
import { IconCircleCheckFilled } from '@tabler/icons-react'
import { AudioEngineNotice } from '@/containers/audios/AudioEngineNotice'
import { ModelLogo } from '@/containers/ModelLogo'
import { AudioModelDetailPanel } from '@/containers/hub/AudioModelDetailPanel'
import { HubNoResults } from '@/containers/hub/HubSearch'
import { HubSearchToolbar } from '@/containers/hub/HubSearchToolbar'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isAudioQuantOnDisk } from '@/lib/audio/models'
import { filterAudioModels } from '@/lib/hub-media'
import { cn } from '@/lib/utils'
import {
  recommendedAudioQuant,
  type AudioCatalogModel,
} from '@/services/audio-catalog-registry'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

export type AudioHubProps = {
  /** The model type picker, first in the toolbar. */
  categoryTabs?: ReactNode
  query: string
  onQueryChange: (query: string) => void
  /** Catalog id of the open model, named by the URL. */
  selectedModelId: string | null
  /** Open a model, or close the open one (`null`). */
  onSelectModel: (modelId: string | null) => void
}

function AudioModelRow({
  model,
  installed,
  selected,
  onSelect,
}: {
  model: AudioCatalogModel
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
        icon={model.icon}
        name={model.name}
        author={model.developer}
        className="size-9 rounded-lg"
      />
      <span className="flex min-w-0 flex-1 flex-col">
        <span className="flex items-center gap-2">
          <span className="min-w-0 flex-1 truncate text-sm font-medium text-foreground">
            {model.name}
          </span>
          <span
            className="shrink-0 rounded-[5px] bg-secondary px-1.5 py-0.5 text-[10px] font-medium text-muted-foreground"
            data-testid={`audio-mode-${model.id}`}
          >
            {t(`audios:mode.${model.mode}.title`)}
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
          {model.description}
        </span>
      </span>
    </button>
  )
}

/**
 * The Hub's Audio category: the speech, music and sound-effect models of the
 * audio catalog, the same list the Audios studio picks from, tagged with
 * their mode. Downloaded models come first; one row per model opens its
 * details below it. What stands between this computer and the engine (an old
 * core, no build, an engine still to install) is said once above the list.
 */
export function AudioHub({
  categoryTabs,
  query,
  onQueryChange,
  selectedModelId,
  onSelectModel,
}: AudioHubProps) {
  const { t } = useTranslation()
  const catalog = useAudioGenerationStore((state) => state.catalog)
  const modelFiles = useAudioGenerationStore((state) => state.modelFiles)

  useEffect(() => {
    void useAudioGenerationStore.getState().bind()
  }, [])

  const sections = useMemo(() => {
    const shown = filterAudioModels(catalog.models, query)
    const onDisk = (model: AudioCatalogModel) =>
      isAudioQuantOnDisk(recommendedAudioQuant(model), modelFiles)
    return {
      installed: shown.filter(onDisk),
      available: shown.filter((model) => !onDisk(model)),
    }
  }, [catalog.models, query, modelFiles])

  const isEmpty =
    sections.installed.length === 0 && sections.available.length === 0

  const renderSection = (
    label: string,
    items: AudioCatalogModel[],
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
                <AudioModelRow
                  model={model}
                  installed={downloaded}
                  selected={open}
                  onSelect={() => onSelectModel(open ? null : model.id)}
                />
                {open && <AudioModelDetailPanel model={model} />}
              </div>
            )
          })}
        </div>
      </section>
    )

  return (
    <div
      className="grid h-svh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]"
      data-testid="audio-hub"
    >
      <HubSearchToolbar
        modelType={categoryTabs}
        value={query}
        onChange={onQueryChange}
        placeholder={t('hub:searchAudioPlaceholder')}
      />

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          <div className="px-2 pt-2 empty:hidden">
            <AudioEngineNotice />
          </div>
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
