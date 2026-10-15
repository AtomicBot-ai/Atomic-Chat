import { memo, useCallback, useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  IconChevronLeft,
  IconChevronRight,
  IconDeviceFloppy,
  IconExternalLink,
  IconFolderOpen,
  IconMovie,
  IconPlayerPlayFilled,
  IconTrash,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import DeleteGalleryVideosDialog from '@/containers/dialogs/DeleteGalleryVideosDialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useVideoForm } from '@/hooks/useVideoForm'
import { useVideoSetting } from '@/hooks/useVideoSetting'
import { useRemoteMediaGroups } from '@/hooks/useRemoteMedia'
import { useRemoteMediaForm } from '@/hooks/useRemoteMediaForm'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureVideoGalleryAction } from '@/lib/diffusion/telemetry'
import {
  exportVideoFilename,
  restoreVideoDraftFromRecipe,
} from '@/lib/video/recipe'
import {
  isRemoteRecipeEngine,
  type GalleryVideoItem,
} from '@/services/diffusion/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import {
  webviewAutoloadsVideo,
  webviewCanPlay,
} from '@/lib/video/webview-playback'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { VideoRecipePopover } from './VideoRecipePopover'

type VideoViewerProps = {
  item: GalleryVideoItem | null
  /** Ids the user has multi-selected; Delete acts on all of them. */
  selectedIds: string[]
  /** When the recipe's model differs and Restore is used, the page offers to load it. */
  onOfferLoad: (artifactId: string) => void
}

const isEditableTarget = (target: EventTarget | null) => {
  if (!(target instanceof HTMLElement)) return false
  const tag = target.tagName
  return (
    tag === 'INPUT' ||
    tag === 'TEXTAREA' ||
    tag === 'SELECT' ||
    target.isContentEditable
  )
}

/**
 * The selected clip in a native player, with the toolbar: recipe, save a
 * copy, reveal in the file manager, delete. The player is the browser's own
 * (controls, sound, fullscreen), fed over the asset protocol; a clip the
 * webview cannot decode gets a button that opens it in the system player.
 * Where the webview may not load clips unasked (Linux), the player is mounted
 * only once Play is pressed; until then the frame shows the poster.
 *
 * Arrow keys step through the gallery and Delete opens the confirmation —
 * unless focus is in a text field, where those keys mean what they always do.
 */
export const VideoViewer = memo(function VideoViewer({
  item,
  selectedIds,
  onOfferLoad,
}: VideoViewerProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const step = useVideoGalleryStore((state) => state.step)
  const applyDraft = useVideoForm((state) => state.applyDraft)
  const selectedArtifactId = useVideoSetting(
    (state) => state.selectedArtifactId
  )
  const setSelectedArtifactId = useVideoSetting(
    (state) => state.setSelectedArtifactId
  )
  const loadedModelId = useImageGenerationStore(
    (state) => state.status?.model.loaded?.modelId ?? null
  )
  const setSelectedRemote = useVideoSetting((state) => state.setSelectedRemote)
  const remoteGroups = useRemoteMediaGroups('video')
  const [pendingDelete, setPendingDelete] = useState<string[]>([])
  const [unplayableId, setUnplayableId] = useState<string | null>(null)
  // The clip whose Play was pressed, where the player is not mounted unasked.
  const [armedId, setArmedId] = useState<string | null>(null)

  const requestDelete = useCallback(() => {
    if (!item) return
    setPendingDelete(selectedIds.length > 0 ? selectedIds : [item.id])
  }, [item, selectedIds])

  useEffect(() => {
    const onKeyDown = (event: KeyboardEvent) => {
      if (isEditableTarget(event.target)) return
      if (event.key === 'ArrowLeft') {
        event.preventDefault()
        step(-1)
      } else if (event.key === 'ArrowRight') {
        event.preventDefault()
        step(1)
      } else if (event.key === 'Delete' || event.key === 'Backspace') {
        if (!item) return
        event.preventDefault()
        requestDelete()
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [step, item, requestDelete])

  if (!item) {
    return (
      <div
        className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground"
        data-testid="video-viewer-empty"
      >
        <IconMovie size={40} stroke={1.5} />
        <p className="text-sm">{t('videos:viewer.empty')}</p>
      </div>
    )
  }

  const src = convertFileSrc(item.path)
  const poster = item.posterPath ? convertFileSrc(item.posterPath) : undefined
  const unplayable = unplayableId === item.id
  const autoloads = webviewAutoloadsVideo()
  const armed = autoloads || armedId === item.id

  const play = () => {
    // Asking the registry builds no pipeline; a clip it cannot demux would hang.
    if (webviewCanPlay(item.path)) setArmedId(item.id)
    else setUnplayableId(item.id)
  }
  // A provider's file whose header the core could not read has no size: 16:9 frames it.
  const [frameWidth, frameHeight] =
    item.width > 0 && item.height > 0 ? [item.width, item.height] : [16, 9]
  const modelDiffers =
    (selectedArtifactId ?? loadedModelId) !== item.recipe.model.modelId

  const restore = () => {
    const engine = item.recipe.engine
    if (isRemoteRecipeEngine(engine)) {
      // A provider's clip: its model becomes the pick again, with what it was asked.
      const pick = {
        provider: engine.provider,
        model: item.recipe.model.modelId,
      }
      const { draft } = restoreVideoDraftFromRecipe(item.recipe)
      applyDraft(draft, `remote:${pick.provider}/${pick.model}`)
      const { recipe } = item
      useRemoteMediaForm.setState({
        video: {
          ...(recipe.remote ?? {}),
          ...(recipe.durationSecs !== undefined
            ? { durationSecs: recipe.durationSecs }
            : {}),
        },
        videoWorkflow:
          recipe.workflow === 'image-to-video' ? 'image-to-video' : 'create',
      })
      captureVideoGalleryAction('restore_recipe')
      const offered = remoteGroups.some(
        (group) =>
          group.provider.provider === pick.provider &&
          group.models.some(({ model }) => model.id === pick.model)
      )
      if (offered) {
        setSelectedRemote(pick)
        toast.success(t('videos:viewer.restored'))
      } else {
        toast.warning(t('images:remote.restoreUnavailable'), {
          description: recipe.model.displayName,
        })
      }
      return
    }
    const { draft, modelId } = restoreVideoDraftFromRecipe(item.recipe)
    // The numbers are the recipe model's: picking that model keeps them.
    applyDraft(draft, item.recipe.model.family)
    captureVideoGalleryAction('restore_recipe')
    if (modelDiffers) {
      setSelectedArtifactId(modelId)
      if (loadedModelId !== modelId) onOfferLoad(modelId)
    }
    toast.success(t('videos:viewer.restored'))
  }

  const saveAs = async () => {
    try {
      const target = await serviceHub
        .dialog()
        .save({ defaultPath: exportVideoFilename(item) })
      if (!target) return
      await serviceHub.diffusion().exportVideoGalleryItem(item.id, target)
      captureVideoGalleryAction('save_as')
      toast.success(t('videos:viewer.saved'))
    } catch (error) {
      toast.error(t('videos:viewer.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const reveal = async () => {
    try {
      await serviceHub.opener().revealItemInDir(item.path)
      captureVideoGalleryAction('reveal')
    } catch (error) {
      toast.error(t('videos:viewer.revealFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  const openInPlayer = async () => {
    try {
      await serviceHub.opener().openPath(item.path)
      captureVideoGalleryAction('open')
    } catch (error) {
      toast.error(t('videos:viewer.openFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div
      className="group/viewer @container grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-2 overflow-hidden px-6 pt-4 pb-2"
      data-testid="video-viewer"
    >
      {/* The frame owns the geometry: the clip's aspect inside the region,
          never larger than either axis, the same way the image viewer sizes
          its bitmap. The player fills the frame. */}
      <div
        className="relative flex min-h-0 min-w-0 items-start justify-center overflow-hidden [container-type:size]"
        data-testid="video-viewer-region"
      >
        <div
          className="relative block shrink-0 overflow-hidden rounded-lg bg-black shadow-md"
          data-testid="video-viewer-frame"
          style={{
            width: `min(100cqw, ${(100 * frameWidth) / frameHeight}cqh)`,
            height: `min(100cqh, ${(100 * frameHeight) / frameWidth}cqw)`,
          }}
        >
          {unplayable ? (
            <div
              className="flex size-full flex-col items-center justify-center gap-3 bg-secondary text-center text-muted-foreground"
              data-testid="video-playback-unsupported"
            >
              <IconMovie size={32} stroke={1.5} />
              <p className="px-6 text-sm">{t('videos:viewer.playbackUnsupported')}</p>
              <Button
                variant="outline"
                size="sm"
                onClick={() => void openInPlayer()}
                data-testid="video-open-in-player"
              >
                <IconExternalLink size={14} />
                {t('videos:viewer.openInPlayer')}
              </Button>
            </div>
          ) : !armed ? (
            <div
              className="relative flex size-full items-center justify-center text-muted-foreground"
              data-testid="video-play-gate"
            >
              {poster ? (
                <img
                  src={poster}
                  alt=""
                  draggable={false}
                  className="absolute inset-0 block size-full object-contain"
                />
              ) : (
                <IconMovie size={32} stroke={1.5} />
              )}
              <Button
                variant="outline"
                size="icon"
                className="absolute rounded-full bg-background/80 backdrop-blur"
                aria-label={t('videos:viewer.play')}
                onClick={play}
                data-testid="video-play"
              >
                <IconPlayerPlayFilled size={18} />
              </Button>
            </div>
          ) : (
            <video
              key={item.id}
              src={src}
              poster={poster}
              controls
              playsInline
              autoPlay={!autoloads}
              preload="metadata"
              className="block size-full object-contain"
              data-testid="video-player"
              onError={() => setUnplayableId(item.id)}
            />
          )}
          <span
            className="pointer-events-none absolute top-2 right-2 rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] tabular-nums text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/viewer:opacity-100"
            data-testid="video-dimension-badge"
          >
            {item.width}×{item.height}
            {item.fps > 0 ? ` · ${item.fps} fps` : ''}
          </span>
        </div>

        <Button
          variant="outline"
          size="icon-sm"
          className="absolute left-0 top-1/2 -translate-y-1/2 bg-background/80 opacity-0 backdrop-blur transition-opacity group-hover/viewer:opacity-100 focus-visible:opacity-100"
          aria-label={t('videos:viewer.previous')}
          onClick={() => step(-1)}
        >
          <IconChevronLeft size={16} />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute right-0 top-1/2 -translate-y-1/2 bg-background/80 opacity-0 backdrop-blur transition-opacity group-hover/viewer:opacity-100 focus-visible:opacity-100"
          aria-label={t('videos:viewer.next')}
          onClick={() => step(1)}
        >
          <IconChevronRight size={16} />
        </Button>
      </div>

      <div className="flex min-w-0 items-center justify-center gap-0.5 [&_button>span]:hidden @[32rem]:[&_button>span]:inline">
        <VideoRecipePopover
          recipe={item.recipe}
          modelDiffers={modelDiffers}
          onRestore={restore}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('videos:viewer.saveAs')}
              onClick={() => void saveAs()}
            >
              <IconDeviceFloppy size={16} />
              <span>{t('videos:viewer.saveAs')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{exportVideoFilename(item)}</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('videos:viewer.reveal')}
          onClick={() => void reveal()}
        >
          <IconFolderOpen size={16} />
          <span>{t('videos:viewer.reveal')}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={requestDelete}
          data-testid="video-viewer-delete"
        >
          <IconTrash size={16} />
          <span>
            {selectedIds.length > 1
              ? t('videos:viewer.deleteCount', { count: selectedIds.length })
              : t('videos:viewer.delete')}
          </span>
        </Button>
      </div>

      <DeleteGalleryVideosDialog
        ids={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete([])
        }}
      />
    </div>
  )
})

export default VideoViewer
