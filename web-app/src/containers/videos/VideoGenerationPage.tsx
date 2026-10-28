import { memo, useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { IconLoader2, IconMovie } from '@tabler/icons-react'
import { toast } from 'sonner'

import { route } from '@/constants/routes'
import { ImageEmptyState } from '@/containers/images/ImageEmptyState'
import { ImageErrorBanner } from '@/containers/images/ImageErrorBanner'
import { ImageSetupCard } from '@/containers/images/ImageSetupCard'
import { MediaStudioFrame } from '@/containers/images/MediaStudio'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useMediaTarget } from '@/hooks/useMediaTarget'
import { useHasRemoteMedia, useRemoteMediaTarget } from '@/hooks/useRemoteMedia'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoGallery } from '@/hooks/useVideoGallery'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { DiffusionErrorAction } from '@/lib/diffusion/errors'
import { artifactId, type InstalledArtifact } from '@/lib/diffusion/models'
import { formatSeconds, secondsForFrames } from '@/lib/video/duration'
import {
  findFamily,
  type DiffusionCatalog,
} from '@/services/diffusion-catalog-registry'
import {
  selectHasInstalledModel,
  useImageGenerationStore,
} from '@/stores/image-generation-store'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { useVideoGenerationStore } from '@/stores/video-generation-store'
import { VideoGalleryGrid } from './VideoGalleryGrid'
import {
  VideoGenerationProgress,
  VideoSlowdownWarning,
} from './VideoGenerationProgress'
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

/**
 * The first complete video checkpoint on disk the local picker offers, in
 * its own order (catalog families, then quants), or null.
 */
function firstInstalledVideoArtifactId(
  catalog: DiffusionCatalog,
  installed: readonly InstalledArtifact[]
): string | null {
  const first = installed.find((artifact) => {
    if (!artifact.complete) return false
    const family = findFamily(catalog, artifact.family)
    return family?.modality === 'video' && family.engines.includes('sdcpp')
  })
  return first?.id ?? null
}

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
  const installedArtifacts = useImageGenerationStore(
    (state) => state.installedArtifacts
  )
  const modelError = useImageGenerationStore((state) =>
    state.lastErrorModality === 'video' ? state.lastError : null
  )
  const clearModelError = useImageGenerationStore((state) => state.clearError)
  const loadModel = useImageGenerationStore((state) => state.loadModel)
  const installEngine = useImageGenerationStore((state) => state.installEngine)
  const generating = useVideoGenerationStore((state) => state.generating)
  const currentJob = useVideoGenerationStore((state) => state.currentJob)
  const generationStartedAtMs = useVideoGenerationStore(
    (state) => state.generationStartedAtMs
  )
  const jobError = useVideoGenerationStore((state) => state.lastError)
  const stopRequested = useVideoGenerationStore((state) => state.stopRequested)
  const stopGeneration = useVideoGenerationStore((state) => state.stop)
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

  // A connected provider's models open the studio without the local engine.
  const hasRemote = useHasRemoteMedia('video')
  const remoteTarget = useRemoteMediaTarget('video')
  const studioReady = engine.installed || hasRemote
  const targetArtifactId = useMediaTarget('video').artifactId
  const modelPicked = targetArtifactId !== null || remoteTarget !== null
  const showLivePreview = generating && viewerMode === 'live'
  // An older core never says; absent reads as no slowdown.
  const slowedDown = generating && currentJob?.progress?.slowdown === true
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

  const onboarding = !studioReady && gallery.items.length === 0
  const openModels = useCallback(() => setModelsOpen(true), [])

  useEffect(() => {
    if (search.model && search.quant) {
      setSelectedArtifactId(artifactId(search.model, search.quant))
      setModelsOpen(true)
    }
  }, [search.model, search.quant, setSelectedArtifactId])

  // Images opens on its model because the pick is stored when a checkpoint
  // is downloaded, started or opened from the Hub. A video checkpoint on
  // disk with no stored pick (never recorded, or cleared by removing another
  // model) left this page on "Select video model" beside a model it could
  // run. With nothing picked, the page takes the resident video model, else
  // the first complete one on disk. A pick, a provider's model or a deep
  // link is the user's and is never replaced; the store is read here, after
  // the deep link above has written it.
  useEffect(() => {
    if (!catalog || (search.model && search.quant)) return
    const settings = useVideoSetting.getState()
    if (settings.selectedArtifactId !== null) return
    if (settings.selectedRemote !== null) return
    const fallback =
      targetArtifactId ??
      firstInstalledVideoArtifactId(catalog, installedArtifacts)
    if (fallback) settings.setSelectedArtifactId(fallback)
  }, [
    catalog,
    installedArtifacts,
    search.model,
    search.quant,
    targetArtifactId,
  ])

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
          void installEngine()
          return
        case 'download':
          if (engine.installed) setModelsOpen(true)
          else void installEngine()
          return
        case 'openSettings':
          void navigate({ to: route.settings.media })
          return
        case 'openCloud':
          void navigate({ to: route.cloud.index })
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
      installEngine,
      navigate,
      patchForm,
      serviceHub,
      status?.videoOutputDir,
    ]
  )

  if (onboarding) {
    return (
      <div className="flex h-svh w-full flex-col">
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
    <MediaStudioFrame testId="video-generation-page">
      <aside className="col-start-1 row-start-1 flex min-h-0 min-w-0 flex-col border-r border-border">
        {studioReady ? (
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

      <section className="relative col-start-2 row-start-1 flex min-h-0 min-w-0 flex-col overflow-hidden">
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
        {slowedDown && (
          <div className="shrink-0 px-6 pt-3">
            <VideoSlowdownWarning
              stopping={stopRequested}
              onStop={() => void stopGeneration()}
            />
          </div>
        )}

        {gallery.initialized && gallery.items.length === 0 && !generating ? (
          <div className="min-h-0 flex-1">
            <ImageEmptyState
              modality="video"
              modelPicked={modelPicked}
              onDownloadModel={
                engine.installed && !hasModel && !remoteTarget
                  ? openModels
                  : undefined
              }
            />
          </div>
        ) : (
          // The media pane: the viewer is as tall as the clip and its actions
          // (capped at three fifths of this pane, in `cqh`), and the gallery
          // takes the rest.
          <div
            className="flex min-h-0 min-w-0 flex-1 flex-col [container-type:size]"
            data-testid="video-media-pane"
          >
            <div
              className="min-w-0 shrink-0 overflow-hidden"
              data-testid="video-viewer-section"
            >
              {showLivePreview ? (
                <VideoGenerationProgress
                  job={currentJob}
                  width={pendingSize.width}
                  height={pendingSize.height}
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
            <div className="flex min-h-0 flex-1 flex-col border-t border-border/60">
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
          </div>
        )}
        {!catalog && !gallery.initialized && (
          <div className="absolute bottom-4 left-6 flex items-center gap-2 text-xs text-muted-foreground">
            <IconLoader2 size={14} className="animate-spin" />
            {t('videos:page.loading')}
          </div>
        )}
      </section>
    </MediaStudioFrame>
  )
})

export default VideoGenerationPage
