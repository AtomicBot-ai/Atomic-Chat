import { memo, useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconLoader2, IconPhoto } from '@tabler/icons-react'
import { toast } from 'sonner'

import HeaderPage from '@/containers/HeaderPage'
import { route } from '@/constants/routes'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useImageForm } from '@/hooks/useImageForm'
import { useImageGallery } from '@/hooks/useImageGallery'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DiffusionErrorAction } from '@/lib/diffusion/errors'
import { artifactId } from '@/lib/diffusion/models'
import type { ImageWorkflowId } from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import { useImageGalleryStore } from '@/stores/image-gallery-store'
import { ImageEmptyState } from './ImageEmptyState'
import { ImageErrorBanner } from './ImageErrorBanner'
import { ImageGalleryGrid } from './ImageGalleryGrid'
import { ImageGenerationPlaceholder } from './ImageGenerationPlaceholder'
import { ImagePromptForm } from './ImagePromptForm'
import { ImageSetupCard } from './ImageSetupCard'
import { ImageViewer } from './ImageViewer'

/** In Upscale "make it smaller" is the scale, not the form's width and height. */
const UPSCALE_ERROR_LABELS = {
  reduceSize: 'images:errors.actions.reduceUpscale',
} as const

type ImageGenerationPageProps = {
  /** The route's workflow: `/images/` is create, `/images/<id>` the rest. */
  workflow: ImageWorkflowId
  /** `?model=&quant=` from the route: preselect (and offer to fetch) that checkpoint. */
  search: { model?: string; quant?: string }
}

/**
 * The form carries the model picker beside the prompt; below the header a
 * settings column (or the setup card until the engine is installed) sits
 * beside the canvas, split by one structural border — the same frame as the Model hub. The
 * error banner sits above the canvas, outside the scrolling grid and never
 * over the picture: its tint is translucent, and text on a photo is unreadable.
 */
export const ImageGenerationPage = memo(function ImageGenerationPage({
  workflow,
  search,
}: ImageGenerationPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const gallery = useImageGallery()
  const viewerMode = useImageGalleryStore((state) => state.viewerMode)
  const selectLive = useImageGalleryStore((state) => state.selectLive)
  const engine = useImageEngine()
  const status = useImageGenerationStore((state) => state.status)
  const generating = useImageGenerationStore((state) => state.generating)
  const currentJob = useImageGenerationStore((state) => state.currentJob)
  const generationStartedAtMs = useImageGenerationStore(
    (state) => state.generationStartedAtMs
  )
  const hasModel = useImageGenerationStore((state) =>
    state.installedArtifacts.some((artifact) => artifact.complete)
  )
  const catalog = useImageGenerationStore((state) => state.catalog)
  const lastError = useImageGenerationStore((state) => state.lastError)
  const clearError = useImageGenerationStore((state) => state.clearError)
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const loadModel = useImageGenerationStore((state) => state.loadModel)
  const patchForm = useImageForm((state) => state.patch)
  const draftWidth = useImageForm((state) => state.width)
  const draftHeight = useImageForm((state) => state.height)
  const draftBatchSize = useImageForm((state) => state.batchSize)
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )
  const [modelsOpen, setModelsOpen] = useState(false)

  const modelLoaded = status?.model.state === 'loaded'
  const showLivePreview = generating && viewerMode === 'live'
  const pendingSize = {
    width: currentJob?.request.width || draftWidth,
    height: currentJob?.request.height || draftHeight,
  }
  const pendingCount = generating
    ? Math.max(1, currentJob?.request.batchSize ?? draftBatchSize)
    : 0
  const pendingStartedAtMs =
    generationStartedAtMs ??
    currentJob?.startedAtMs ??
    currentJob?.createdAtMs ??
    0

  // The route names the workflow; the form carries it into the request.
  useEffect(() => {
    patchForm({ workflow })
  }, [workflow, patchForm])

  // The engine is the only gate: models are fetched from the form's own
  // picker, so the studio opens as soon as there is something to run them.
  // No engine and nothing to look at: one centered setup card instead of a
  // form-column card beside an empty canvas. Existing images keep the gallery
  // visible.
  const onboarding = !engine.installed && gallery.items.length === 0
  const openModels = useCallback(() => setModelsOpen(true), [])

  // A deep link picks the checkpoint; the picker then shows its plan if it
  // is not on disk yet.
  useEffect(() => {
    if (search.model && search.quant) {
      setSelectedArtifactId(artifactId(search.model, search.quant))
      setModelsOpen(true)
    }
  }, [search.model, search.quant, setSelectedArtifactId])

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
        case 'updateEngine':
          void useImageGenerationStore.getState().updateEngine()
          return
        case 'install':
          openSetup(1)
          return
        case 'download':
          // The picker lives in the form, which needs the engine first.
          if (engine.installed) setModelsOpen(true)
          else openSetup(1)
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
          if (workflow === 'upscale') {
            // The output is the source times the scale; the form's size is
            // not in the request, so 768² would change nothing here.
            const { upscaleFactor } = useImageForm.getState()
            patchForm({ upscaleFactor: Math.max(1.5, upscaleFactor - 0.5) })
            return
          }
          patchForm({
            width: 768,
            height: 768,
            aspect: 'square',
            portrait: false,
          })
          return
        case 'pickSmallerQuant':
          setModelsOpen(true)
          return
        case 'retry':
          return
      }
    },
    [
      clearError,
      engine.installed,
      navigate,
      openSetup,
      patchForm,
      serviceHub,
      status?.outputDir,
      workflow,
    ]
  )

  const errorLabelKeys =
    workflow === 'upscale' ? UPSCALE_ERROR_LABELS : undefined

  const header = (
    <HeaderPage>
      <div className="flex w-full items-center gap-2">
        <span className="font-studio text-base font-medium">
          {t('images:page.title')}
        </span>
      </div>
    </HeaderPage>
  )

  if (onboarding) {
    return (
      <div className="flex h-svh w-full flex-col">
        {header}
        <div className="flex min-h-0 flex-1 flex-col gap-3 px-4 pb-4">
          <ImageErrorBanner
            error={lastError}
            onAction={onErrorAction}
            onDismiss={clearError}
            actionLabelKeys={errorLabelKeys}
          />
          <div
            className="flex min-h-0 flex-1 overflow-y-auto"
            data-testid="image-onboarding"
          >
            <ImageSetupCard className="m-auto" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="grid h-svh w-full grid-cols-[minmax(340px,400px)_1fr] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      data-testid="image-generation-page"
    >
      <div className="col-span-2 min-w-0">{header}</div>

      <aside className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col border-r border-border">
        {engine.installed ? (
          <ImagePromptForm
            modelsOpen={modelsOpen}
            onModelsOpenChange={setModelsOpen}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <ImageSetupCard />
          </div>
        )}
      </aside>

      <section className="relative col-start-2 row-start-2 flex min-h-0 min-w-0 flex-col overflow-hidden">
        {lastError && (
          <div className="shrink-0 px-6 pt-3">
            <ImageErrorBanner
              error={lastError}
              onAction={onErrorAction}
              onDismiss={clearError}
              actionLabelKeys={errorLabelKeys}
            />
          </div>
        )}

        {gallery.initialized && gallery.items.length === 0 && !generating ? (
          <div className="min-h-0 flex-1">
            <ImageEmptyState
              modelLoaded={modelLoaded}
              onDownloadModel={
                engine.installed && !hasModel ? openModels : undefined
              }
            />
          </div>
        ) : (
          <>
            <div
              className="min-h-0 min-w-0 flex-[3] overflow-hidden"
              data-testid="image-viewer-section"
            >
              {showLivePreview ? (
                <ImageGenerationPlaceholder
                  variant="viewer"
                  width={pendingSize.width}
                  height={pendingSize.height}
                  progress={currentJob?.progress ?? null}
                  startedAtMs={pendingStartedAtMs}
                />
              ) : (
                <ImageViewer
                  item={gallery.selected}
                  selectedIds={gallery.selectedIds}
                  onOfferLoad={offerLoad}
                />
              )}
            </div>
            <div className="flex min-h-0 flex-[2] flex-col border-t border-border/60">
              <div className="flex shrink-0 items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
                <IconPhoto size={14} />
                {/* A bare number: the i18n layer has no plural forms. */}
                <span>{t('images:gallery.title')}</span>
                <span className="tabular-nums">
                  {gallery.total + pendingCount}
                </span>
                {gallery.selectedIds.length > 1 && (
                  <span>
                    ·{' '}
                    {t('images:gallery.selectedCount', {
                      count: gallery.selectedIds.length,
                    })}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
                <ImageGalleryGrid
                  items={gallery.items}
                  selectedId={showLivePreview ? null : gallery.selectedId}
                  selectedIds={showLivePreview ? [] : gallery.selectedIds}
                  hasMore={gallery.hasMore}
                  loading={gallery.loading}
                  pendingCount={pendingCount}
                  pendingSize={pendingSize}
                  pendingProgress={currentJob?.progress ?? null}
                  pendingStartedAtMs={pendingStartedAtMs}
                  pendingSelected={showLivePreview}
                  onSelectPending={selectLive}
                  onSelect={gallery.toggleSelect}
                  onOpen={gallery.select}
                  onLoadMore={() => void gallery.loadMore()}
                />
              </div>
            </div>
          </>
        )}
        {!catalog && !gallery.initialized && (
          <div className="absolute bottom-4 left-6 flex items-center gap-2 text-xs text-muted-foreground">
            <IconLoader2 size={14} className="animate-spin" />
            {t('images:page.loading')}
          </div>
        )}
      </section>
    </div>
  )
})

export default ImageGenerationPage
