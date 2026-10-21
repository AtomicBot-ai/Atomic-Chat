import { useMemo, type ReactNode } from 'react'
import { HubNoResults } from '@/containers/hub/HubSearch'
import { HubSearchToolbar } from '@/containers/hub/HubSearchToolbar'
import { MediaFamilyDetailPanel } from '@/containers/hub/MediaFamilyDetailPanel'
import { MediaFamilyRow } from '@/containers/hub/MediaFamilyRow'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  filterFamiliesBySearch,
  mediaFamilies,
  splitByInstalled,
} from '@/lib/hub-media'
import type { DiffusionModality } from '@/services/diffusion/types'
import type { DiffusionCatalogFamily } from '@/services/diffusion-catalog-registry'
import { useImageGenerationStore } from '@/stores/image-generation-store'

export type MediaHubProps = {
  modality: DiffusionModality
  /** The model type picker, first in the toolbar. */
  categoryTabs?: ReactNode
  query: string
  onQueryChange: (query: string) => void
  /** Id of the open family, named by the URL. */
  selectedFamilyId: string | null
  /** Open a family, or close the open one (`null`). */
  onSelectFamily: (familyId: string | null) => void
}

/**
 * The Hub's Images and Video categories: the curated diffusion catalog, one
 * row per family, the open one with its details below it. Installed families
 * come first; the search box narrows the list by name, developer, description
 * or repo. Nothing is open until the user opens it.
 */
export function MediaHub({
  modality,
  categoryTabs,
  query,
  onQueryChange,
  selectedFamilyId,
  onSelectFamily,
}: MediaHubProps) {
  const { t } = useTranslation()
  const catalog = useImageGenerationStore((state) => state.catalog)
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )

  const families = useMemo(
    () => mediaFamilies(catalog, modality),
    [catalog, modality]
  )
  const installedIds = useMemo(
    () => new Set(installedArtifacts.map((artifact) => artifact.id)),
    [installedArtifacts]
  )
  const sections = useMemo(
    () =>
      splitByInstalled(filterFamiliesBySearch(families, query), installedIds),
    [families, query, installedIds]
  )

  const placeholder =
    modality === 'video'
      ? t('hub:searchVideoPlaceholder')
      : t('hub:searchImagePlaceholder')
  const isEmpty =
    sections.installed.length === 0 && sections.available.length === 0

  const renderSection = (
    label: string,
    items: DiffusionCatalogFamily[],
    installed: boolean
  ) =>
    items.length > 0 && (
      <section>
        <h2 className="px-2 pb-2 pt-4 text-base font-semibold text-foreground">
          {label}
        </h2>
        <div className="flex flex-col gap-1">
          {items.map((family) => {
            const open = family.id === selectedFamilyId
            return (
              <div key={family.id} className="rounded-lg border border-border">
                <MediaFamilyRow
                  family={family}
                  installed={installed}
                  selected={open}
                  onSelect={() => onSelectFamily(open ? null : family.id)}
                />
                {open && <MediaFamilyDetailPanel family={family} />}
              </div>
            )
          })}
        </div>
      </section>
    )

  return (
    <div className="grid h-svh w-full min-w-0 grid-cols-[minmax(0,1fr)] grid-rows-[auto_minmax(0,1fr)]">
      <HubSearchToolbar
        modelType={categoryTabs}
        value={query}
        onChange={onQueryChange}
        placeholder={placeholder}
      />

      <div className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col">
        <div className="min-h-0 flex-1 overflow-y-auto p-2">
          {!catalog ? (
            <p className="p-4 text-center text-sm text-muted-foreground">
              {t('images:model.loadingCatalog')}
            </p>
          ) : isEmpty ? (
            <HubNoResults
              message={t('hub:noModels')}
              onClearSearch={
                query.length > 0 ? () => onQueryChange('') : undefined
              }
            />
          ) : (
            <>
              {renderSection(
                t('images:model.installed'),
                sections.installed,
                true
              )}
              {renderSection(
                t('images:model.available'),
                sections.available,
                false
              )}
            </>
          )}
        </div>
      </div>
    </div>
  )
}
