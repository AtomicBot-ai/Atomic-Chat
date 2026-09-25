import { memo, useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconLoader2, IconMovie } from '@tabler/icons-react'
import { toast } from 'sonner'

import HeaderPage from '@/containers/HeaderPage'
import { route } from '@/constants/routes'
import { ImageEmptyState } from '@/containers/images/ImageEmptyState'
import { ImageErrorBanner } from '@/containers/images/ImageErrorBanner'
import { ImageGenerationPlaceholder } from '@/containers/images/ImageGenerationPlaceholder'
import { ImageSetupCard } from '@/containers/images/ImageSetupCard'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoGallery } from '@/hooks/useVideoGallery'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DiffusionErrorAction } from '@/lib/diffusion/errors'
import { artifactId } from '@/lib/diffusion/models'
import { cn } from '@/lib/utils'
import { formatSeconds, secondsForFrames } from '@/lib/video/duration'
import {
  selectHasInstalledModel,
  useImageGenerationStore,
} from '@/stores/image-generation-store'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoGalleryGrid } from './VideoGalleryGrid'
import { VideoPromptForm } from './VideoPromptForm'
import { VideoViewer } from './VideoViewer'

/** "Make it smaller" on this page means the smallest preset, not 768². */
const VIDEO_ERROR_LABELS = {
  reduceSize: 'videos:errors.actions.reduceSize',
} as const

/** The codes whose image copy would mislead here: a clip that did not fit, an engine that failed a clip. */
const VIDEO_ERROR_COPY = {
  OUT_OF_MEMORY: {
    titleKey: 'videos:errors.OUT_OF_MEMORY.title',
    bodyKey: 'videos:errors.OUT_OF_MEMORY.body',
  },
  INTERNAL: {
    titleKey: 'videos:errors.INTERNAL.title',
    bodyKey: 'videos:errors.INTERNAL.body',
  },
} as const

type VideoGenerationPageProps = {
  /** `?model=&quant=` from the route: preselect (and offer to fetch) that checkpoint. */
  search: { model?: string; quant?: string }
}

/**
 * The Video page: the same frame as Images — the form column (or the setup
 * card until the engine is installed) beside the viewer over the gallery,
 * the error banner above the viewer. The engine, the resident model and
 * model-level errors come from the image store; the job and the gallery from
 * the video stores.
 */
export const VideoGenerationPage = memo(function VideoGenerationPage({
  search,
}: VideoGenerationPageProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const gallery = useVideoGallery()
  const viewerMode = useVideoGalleryStore((state) => state.viewerMode)
  const selectLive = useVideoGalleryStore((state) => state.selectLive)
  const engine = useImageEngine()
  const status = useImageGenerationStore((state) => state.status)
  const capabilities = useImageGenerationStore(
    (state) => state.videoCapabilities
  )
  const hasModel = useImageGenerationStore(selectHasInstalledModel('video'))
  const catalog = useImageGenerationStore((state) => state.catalog)
  const modelError = useImageGenerationStore((state) =>
    state.lastErrorModality === 'video' ? state.lastError : null
  )
  const clearModelError = useImageGenerationStore((state) => state.clearError)
  const openSetup = useImageGenerationStore((state) => state.openSetup)
  const loadModel = useImageGenerationStore((state) => state.loadModel)
  const generating = useVideoGenerationStore((state) => state.generating)
  const currentJob = useVideoGenerationStore((state) => state.currentJob)
  const generationStartedAtMs = useVideoGenerationStore(
    (state) => state.generationStartedAtMs
  )
  const jobError = useVideoGenerationStore((state) => state.lastError)
  const clearJobError = useVideoGenerationStore((state) => state.clearError)
  const requestPoster = useVideoGenerationStore((state) => state.requestPoster)
  const patchForm = useVideoForm((state) => state.patch)
  const draftWidth = useVideoForm((state) => state.width)
  const draftHeight = useVideoForm((state) => state.height)
  const draftFrames = useVideoForm((state) => state.frames)
  const setSelectedArtifactId = useVideoSetting(
    (state) => state.setSelectedArtifactId
  )
  const [modelsOpen, setModelsOpen] = useState(false)

  const modelLoaded =
    status?.model.state === 'loaded' &&
    status.model.loaded?.modality === 'video'
  const showLivePreview = generating && viewerMode === 'live'
  const pendingSize = {
    width: currentJob?.request.width || draftWidth,
    height: currentJob?.request.height || draftHeight,
  }
  const pendingStartedAtMs =
    generationStartedAtMs ??
    currentJob?.startedAtMs ??
    currentJob?.createdAtMs ??
    0
  // A job error is this page's; a model error is shown here only when it
  // was filed under video (the image page shows the rest).
  const lastError = jobError ?? modelError
  // What the failed clip asked for: the job's request while it is known, else the form.
  const failedRequest = currentJob?.request
  const errorValues = {
    frames: failedRequest?.frames ?? draftFrames,
    seconds: formatSeconds(
      secondsForFrames(
        failedRequest?.frames ?? draftFrames,
        failedRequest?.fps ?? capabilities?.fps ?? 24
      )
    ),
    size: `${failedRequest?.width ?? draftWidth}×${failedRequest?.height ?? draftHeight}`,
  }
  const clearError = useCallback(() => {
    clearJobError()
    if (useImageGenerationStore.getState().lastErrorModality === 'video') {
      clearModelError()
    }
  }, [clearJobError, clearModelError])

  const onboarding = !engine.installed && gallery.items.length === 0
  const openModels = useCallback(() => setModelsOpen(true), [])

  useEffect(() => {
    if (search.model && search.quant) {
      setSelectedArtifactId(artifactId(search.model, search.quant))
      setModelsOpen(true)
    }
  }, [search.model, search.quant, setSelectedArtifactId])

  const offerLoad = useCallback(
    (id: string) => {
      toast.info(t('videos:viewer.loadOffer'), {
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
          openSetup(1, 'video')
          return
        case 'download':
          if (engine.installed) setModelsOpen(true)
          else openSetup(1, 'video')
          return
        case 'openSettings':
          void navigate({ to: route.settings.media })
          return
        case 'openOutputFolder':
          if (status?.videoOutputDir) {
            void serviceHub.opener().openPath(status.videoOutputDir)
          }
          return
        case 'reduceSize': {
          const presets = capabilities?.resolutionPresets ?? []
          const smallest = [...presets].sort(
            (a, b) => a[0] * a[1] - b[0] * b[1]
          )[0] ?? [768, 512]
          patchForm({ width: smallest[0], height: smallest[1] })
          return
        }
        case 'pickSmallerQuant':
          setModelsOpen(true)
          return
        case 'retry':
          return
      }
    },
    [
      capabilities,
      clearError,
      engine.installed,
      navigate,
      openSetup,
      patchForm,
      serviceHub,
      status?.videoOutputDir,
    ]
  )

  const header = (
    <HeaderPage>
      <div
        className={cn(
          'flex w-full items-center gap-2 pr-3',
          !IS_MACOS && 'pr-30'
        )}
      >
        <span className="font-studio text-base font-medium">
          {t('videos:page.title')}
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
            actionLabelKeys={VIDEO_ERROR_LABELS}
            copyKeys={VIDEO_ERROR_COPY}
            copyValues={errorValues}
          />
          <div
            className="flex min-h-0 flex-1 overflow-y-auto"
            data-testid="video-onboarding"
          >
            <ImageSetupCard className="m-auto" modality="video" />
          </div>
        </div>
      </div>
    )
  }

  return (
    <div
      className="grid h-svh w-full grid-cols-[minmax(340px,400px)_1fr] grid-rows-[auto_minmax(0,1fr)] overflow-hidden"
      data-testid="video-generation-page"
    >
      <div className="col-span-2 min-w-0">{header}</div>

      <aside className="col-start-1 row-start-2 flex min-h-0 min-w-0 flex-col border-r border-border">
        {engine.installed ? (
          <VideoPromptForm
            modelsOpen={modelsOpen}
            onModelsOpenChange={setModelsOpen}
          />
        ) : (
          <div className="min-h-0 flex-1 overflow-y-auto p-4">
            <ImageSetupCard modality="video" />
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
              actionLabelKeys={VIDEO_ERROR_LABELS}
              copyKeys={VIDEO_ERROR_COPY}
              copyValues={errorValues}
            />
          </div>
        )}

        {gallery.initialized && gallery.items.length === 0 && !generating ? (
          <div className="min-h-0 flex-1">
            <ImageEmptyState
              modality="video"
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
              data-testid="video-viewer-section"
            >
              {showLivePreview ? (
                <ImageGenerationPlaceholder
                  variant="viewer"
                  kind="video"
                  width={pendingSize.width}
                  height={pendingSize.height}
                  progress={currentJob?.progress ?? null}
                  startedAtMs={pendingStartedAtMs}
                />
              ) : (
                <VideoViewer
                  item={gallery.selected}
                  selectedIds={gallery.selectedIds}
                  onOfferLoad={offerLoad}
                />
              )}
            </div>
            <div className="flex min-h-0 flex-[2] flex-col border-t border-border/60">
              <div className="flex shrink-0 items-center gap-2 px-6 py-2 text-xs text-muted-foreground">
                <IconMovie size={14} />
                <span>{t('videos:gallery.title')}</span>
                <span className="tabular-nums">
                  {gallery.total + (generating ? 1 : 0)}
                </span>
                {gallery.selectedIds.length > 1 && (
                  <span>
                    ·{' '}
                    {t('videos:gallery.selectedCount', {
                      count: gallery.selectedIds.length,
                    })}
                  </span>
                )}
              </div>
              <div className="min-h-0 flex-1 overflow-y-auto px-6 pb-4">
                <VideoGalleryGrid
                  items={gallery.items}
                  selectedId={showLivePreview ? null : gallery.selectedId}
                  selectedIds={showLivePreview ? [] : gallery.selectedIds}
                  hasMore={gallery.hasMore}
                  loading={gallery.loading}
                  pending={generating}
                  pendingSize={pendingSize}
                  pendingProgress={currentJob?.progress ?? null}
                  pendingStartedAtMs={pendingStartedAtMs}
                  pendingSelected={showLivePreview}
                  onSelectPending={selectLive}
                  onSelect={gallery.toggleSelect}
                  onOpen={gallery.select}
                  onLoadMore={() => void gallery.loadMore()}
                  onVisibleWithoutPoster={requestPoster}
                />
              </div>
            </div>
          </>
        )}
        {!catalog && !gallery.initialized && (
          <div className="absolute bottom-4 left-6 flex items-center gap-2 text-xs text-muted-foreground">
            <IconLoader2 size={14} className="animate-spin" />
            {t('videos:page.loading')}
          </div>
        )}
      </section>
    </div>
  )
})

export default VideoGenerationPage
