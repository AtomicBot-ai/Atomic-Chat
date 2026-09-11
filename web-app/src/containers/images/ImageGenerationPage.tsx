import { memo, useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconLoader2, IconPhoto, IconSettings } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import HeaderPage from '@/containers/HeaderPage'
import { route } from '@/constants/routes'
import { useImageArtifact } from '@/hooks/useImageArtifact'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useImageForm } from '@/hooks/useImageForm'
import { useImageGallery } from '@/hooks/useImageGallery'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DiffusionErrorAction } from '@/lib/diffusion/errors'
import { artifactId } from '@/lib/diffusion/models'
import { cn } from '@/lib/utils'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { ImageEmptyState } from './ImageEmptyState'
import { ImageErrorBanner } from './ImageErrorBanner'
import { ImageGalleryGrid } from './ImageGalleryGrid'
import { ImageModelSelector } from './ImageModelSelector'
import { ImagePromptForm } from './ImagePromptForm'
import { ImageSetupCard } from './ImageSetupCard'
import { ImageViewer } from './ImageViewer'

type ImageGenerationPageProps = {
  /** `?model=&quant=` from the route: preselect (and offer to fetch) that checkpoint. */
  search: { model?: string; quant?: string }
}

/**
 * Two columns: the form (or the setup card until the prerequisites are met)
 * on the left, the viewer over the gallery grid on the right. The error
 * banner sits above both so it is never hidden behind a scrolled grid.
 */
export const ImageGenerationPage = memo(function ImageGenerationPage({
  search,
}: ImageGenerationPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const gallery = useImageGallery()
  const engine = useImageEngine()
  const status = useImageGenerationStore((state) => state.status)
  const hasModel = useImageGenerationStore((state) =>
    state.installedArtifacts.some((artifact) => artifact.complete)
  )
  const catalog = useImageGenerationStore((state) => state.catalog)
  const lastError = useImageGenerationStore((state) => state.lastError)
  const clearError = useImageGenerationStore((state) => state.clearError)
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const loadModel = useImageGenerationStore((state) => state.loadModel)
  const patchForm = useImageForm((state) => state.patch)
  const selectedArtifactId = useImageSetting((state) => state.selectedArtifactId)
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )
  const setupCompleted = useImageSetting((state) => state.setupCompleted)
  const selected = useImageArtifact(selectedArtifactId ?? '')
  const [modelsOpen, setModelsOpen] = useState(false)

  const ready = engine.installed && hasModel

  // A deep link picks the checkpoint; the selector then shows its plan if it
  // is not on disk yet.
  useEffect(() => {
    if (search.model && search.quant) {
      setSelectedArtifactId(artifactId(search.model, search.quant))
      setModelsOpen(true)
    }
  }, [search.model, search.quant, setSelectedArtifactId])

  // First visit with nothing set up: open the wizard rather than leave a
  // page that does nothing.
  useEffect(() => {
    if (!setupCompleted && !ready && status && engine.hostBackendId !== null) {
      openSetup(engine.installed ? 2 : 0)
    }
    // Only when readiness is first known.
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [status !== null, ready])

  const offerLoad = useCallback(
    (id: string) => {
      toast.info(t('images:viewer.loadOffer'), {
        action: {
          label: t('images:model.load'),
          onClick: () => void loadModel(id),
        },
      })
    },
    [loadModel, t]
  )

  const onErrorAction = useCallback(
    (action: DiffusionErrorAction) => {
      clearError()
      switch (action) {
        case 'install':
          openSetup(1)
          return
        case 'download':
          openSetup(2)
          return
        case 'openSettings':
          void navigate({ to: route.settings.media })
          return
        case 'openOutputFolder':
          if (status?.outputDir) {
            void serviceHub.opener().openPath(status.outputDir)
          }
          return
        case 'reduceSize':
          patchForm({ width: 768, height: 768, aspect: 'square', portrait: false })
          return
        case 'pickSmallerQuant':
          setModelsOpen(true)
          return
        case 'retry':
          return
      }
    },
    [clearError, navigate, openSetup, patchForm, serviceHub, status?.outputDir]
  )

  const loadedName = status?.model.loaded?.displayName ?? null
  const modelLine =
    selected.family && selected.quant
      ? `${selected.family.name} · ${selected.quant.label}`
      : loadedName ?? t('images:model.none')

  return (
    <div className="flex h-svh w-full flex-col">
      <HeaderPage>
        <div
          className={cn(
            'mr-2 flex w-full items-center justify-between pr-3',
            !IS_MACOS && 'pr-30'
          )}
        >
          <span className="font-studio text-base font-medium">
            {t('images:page.title')}
          </span>
          <Button
            variant="ghost"
            size="icon-sm"
            aria-label={t('common:media')}
            onClick={() => void navigate({ to: route.settings.media })}
          >
            <IconSettings size={16} />
          </Button>
        </div>
      </HeaderPage>

      <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
        <ImageErrorBanner
          error={lastError}
          onAction={onErrorAction}
          onDismiss={clearError}
        />

        <div className="grid min-h-0 flex-1 grid-cols-1 gap-4 lg:grid-cols-[360px_minmax(0,1fr)]">
          <aside className="flex min-h-0 flex-col gap-3 overflow-y-auto pr-1">
            {ready ? (
              <>
                <div className="rounded-xl border bg-secondary/40 p-3">
                  <div className="flex items-center justify-between gap-2">
                    <div className="min-w-0">
                      <p className="text-[11px] font-medium uppercase tracking-wider text-muted-foreground">
                        {t('images:model.selector')}
                      </p>
                      <p className="truncate text-sm font-medium" title={modelLine}>
                        {modelLine}
                      </p>
                      <p className="text-xs text-muted-foreground">
                        {status?.model.state === 'loading' || selected.loading ? (
                          <span className="flex items-center gap-1">
                            <IconLoader2 size={12} className="animate-spin" />
                            {t('images:model.loading')}
                          </span>
                        ) : selected.loaded ? (
                          t('images:model.loaded')
                        ) : selected.complete ? (
                          t('images:model.readyToLoad')
                        ) : (
                          t('images:model.notInstalled')
                        )}
                      </p>
                    </div>
                    <Button
                      variant="outline"
                      size="sm"
                      onClick={() => setModelsOpen((open) => !open)}
                      aria-expanded={modelsOpen}
                      data-testid="image-models-toggle"
                    >
                      {modelsOpen ? t('common:close') : t('images:model.change')}
                    </Button>
                  </div>
                  {modelsOpen && (
                    <ImageModelSelector className="mt-3" variant="page" />
                  )}
                </div>
                <ImagePromptForm />
              </>
            ) : (
              <ImageSetupCard />
            )}
          </aside>

          <section className="flex min-h-0 flex-col gap-3">
            {gallery.initialized && gallery.items.length === 0 ? (
              <ImageEmptyState
                onPickPrompt={(prompt) => patchForm({ prompt })}
              />
            ) : (
              <>
                <div className="min-h-0 flex-[3]">
                  <ImageViewer
                    item={gallery.selected}
                    selectedIds={gallery.selectedIds}
                    onOfferLoad={offerLoad}
                  />
                </div>
                <div className="min-h-0 flex-[2] overflow-y-auto">
                  <div className="mb-2 flex items-center gap-2 text-xs text-muted-foreground">
                    <IconPhoto size={14} />
                    <span>{t('images:gallery.count', { count: gallery.total })}</span>
                    {gallery.selectedIds.length > 1 && (
                      <span>
                        · {t('images:gallery.selectedCount', {
                          count: gallery.selectedIds.length,
                        })}
                      </span>
                    )}
                  </div>
                  <ImageGalleryGrid
                    items={gallery.items}
                    selectedId={gallery.selectedId}
                    selectedIds={gallery.selectedIds}
                    hasMore={gallery.hasMore}
                    loading={gallery.loading}
                    onSelect={gallery.toggleSelect}
                    onOpen={gallery.select}
                    onLoadMore={() => void gallery.loadMore()}
                  />
                </div>
              </>
            )}
            {!catalog && !gallery.initialized && (
              <div className="flex items-center gap-2 text-xs text-muted-foreground">
                <IconLoader2 size={14} className="animate-spin" />
                {t('images:page.loading')}
              </div>
            )}
          </section>
        </div>
      </div>
    </div>
  )
})

export default ImageGenerationPage
