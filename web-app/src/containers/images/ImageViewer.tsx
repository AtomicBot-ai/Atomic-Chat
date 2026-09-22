import { memo, useCallback, useEffect, useState } from 'react'
import { useNavigate } from '@tanstack/react-router'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  IconChevronLeft,
  IconChevronRight,
  IconDeviceFloppy,
  IconFolderOpen,
  IconPhoto,
  IconPhotoUp,
  IconTrash,
} from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import DeleteGalleryImagesDialog from '@/containers/dialogs/DeleteGalleryImagesDialog'
import { useImageForm } from '@/hooks/useImageForm'
import { useImageSetting } from '@/hooks/useImageSetting'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { exportFilename, restoreDraftFromRecipe } from '@/lib/diffusion/recipe'
import { captureImageGalleryAction } from '@/lib/diffusion/telemetry'
import { workflowPath } from '@/lib/diffusion/workflows'
import { useImageGalleryStore } from '@/stores/image-gallery-store'
import { useImageGenerationStore } from '@/stores/image-generation-store'
import type { GalleryImageItem } from '@/services/diffusion/types'
import { ImageRecipePopover } from './ImageRecipePopover'

type ImageViewerProps = {
  item: GalleryImageItem | null
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
 * The selected image, large, with the toolbar: recipe, save a copy, reveal in
 * the file manager, delete. Click the image for a full-screen preview.
 *
 * Arrow keys step through the gallery and Delete opens the confirmation —
 * unless focus is in a text field, where those keys mean what they always do.
 */
export const ImageViewer = memo(function ImageViewer({
  item,
  selectedIds,
  onOfferLoad,
}: ImageViewerProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const serviceHub = useServiceHub()
  const step = useImageGalleryStore((state) => state.step)
  const applyDraft = useImageForm((state) => state.applyDraft)
  const runs = useImageForm((state) => state.runs)
  const setSourceImage = useImageForm((state) => state.setSourceImage)
  const workflow = useImageForm((state) => state.workflow)
  const selectedArtifactId = useImageSetting(
    (state) => state.selectedArtifactId
  )
  const setSelectedArtifactId = useImageSetting(
    (state) => state.setSelectedArtifactId
  )
  const loadedModelId = useImageGenerationStore(
    (state) => state.status?.model.loaded?.modelId ?? null
  )
  const [fullscreen, setFullscreen] = useState(false)
  const [pendingDelete, setPendingDelete] = useState<string[]>([])

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
      } else if (event.key === 'Escape' && fullscreen) {
        setFullscreen(false)
      }
    }
    document.addEventListener('keydown', onKeyDown)
    return () => document.removeEventListener('keydown', onKeyDown)
  }, [step, item, requestDelete, fullscreen])

  if (!item) {
    return (
      <div
        className="flex h-full min-h-48 flex-col items-center justify-center gap-3 text-muted-foreground"
        data-testid="image-viewer-empty"
      >
        <IconPhoto size={40} stroke={1.5} />
        <p className="text-sm">{t('images:viewer.empty')}</p>
      </div>
    )
  }

  const src = convertFileSrc(item.path)
  const modelDiffers =
    (selectedArtifactId ?? loadedModelId) !== item.recipe.model.modelId

  const restore = () => {
    const { draft, modelId } = restoreDraftFromRecipe(item.recipe, runs)
    applyDraft(draft)
    captureImageGalleryAction('restore_recipe')
    if (modelDiffers) {
      setSelectedArtifactId(modelId)
      if (loadedModelId !== modelId) onOfferLoad(modelId)
    }
    toast.success(t('images:viewer.restored'))
  }

  const saveAs = async () => {
    try {
      const target = await serviceHub
        .dialog()
        .save({ defaultPath: exportFilename(item) })
      if (!target) return
      await serviceHub.diffusion().exportGalleryItem(item.id, target)
      captureImageGalleryAction('save_as')
      toast.success(t('images:viewer.saved'))
    } catch (error) {
      toast.error(t('images:viewer.saveFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  // The gallery → workflow handoff: this picture becomes the source. On
  // Create there is nothing to feed, so the page moves to Transform.
  const useAsSource = () => {
    setSourceImage({ path: item.path, width: item.width, height: item.height })
    captureImageGalleryAction('use_as_source')
    if (workflow === 'create') void navigate({ to: workflowPath('transform') })
    toast.success(t('images:viewer.useAsSourceDone'))
  }

  const reveal = async () => {
    try {
      await serviceHub.opener().revealItemInDir(item.path)
      captureImageGalleryAction('reveal')
    } catch (error) {
      toast.error(t('images:viewer.revealFailed'), {
        description: error instanceof Error ? error.message : String(error),
      })
    }
  }

  return (
    <div
      className="group/viewer @container grid h-full min-h-0 min-w-0 grid-rows-[minmax(0,1fr)_auto] gap-2 overflow-hidden px-6 pt-4 pb-2"
      data-testid="image-viewer"
    >
      {/* Keep the control itself definite-sized. If it shrink-wraps the
          intrinsic bitmap, percentage max sizes become circular and can be
          recomputed differently after a workflow route change. */}
      <div
        className="relative flex min-h-0 min-w-0 items-start justify-center overflow-hidden [container-type:size]"
        data-testid="image-viewer-region"
      >
        <button
          type="button"
          className="group/image relative flex size-full min-h-0 min-w-0 items-start justify-center overflow-hidden rounded-lg outline-none focus-visible:ring-2 focus-visible:ring-ring"
          aria-label={t('images:viewer.fullscreen')}
          onClick={() => {
            setFullscreen(true)
            captureImageGalleryAction('open')
          }}
        >
          <span
            className="relative block shrink-0 overflow-hidden rounded-lg shadow-md"
            data-testid="image-viewer-frame"
            style={{
              width: `min(100cqw, ${100 * item.width / item.height}cqh)`,
              height: `min(100cqh, ${100 * item.height / item.width}cqw)`,
            }}
          >
            {/* The frame owns geometry and clipping from the first paint. Only
                this inner layer is animated, and only its opacity changes, so
                a decoded (including cached) bitmap can never render outside
                the final rounded shape while WebKit promotes the transition. */}
            <span
              key={item.id}
              className="absolute inset-0 animate-in fade-in-0 duration-300 motion-reduce:animate-none"
              data-testid="image-viewer-transition"
            >
              <img
                src={src}
                alt={item.recipe.prompt}
                decoding="async"
                draggable={false}
                className="block size-full min-h-0 min-w-0 cursor-zoom-in object-contain object-top"
              />
              <span
                className="pointer-events-none absolute top-2 right-2 rounded-md bg-black/55 px-2 py-1 font-mono text-[10px] tabular-nums text-white opacity-0 backdrop-blur-sm transition-opacity group-hover/image:opacity-100 group-focus-visible/image:opacity-100"
                data-testid="image-dimension-badge"
              >
                {item.width}×{item.height}
              </span>
            </span>
          </span>
        </button>

        {/* Stepping arrows, shown when the pointer is over the canvas. */}
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute left-0 top-1/2 -translate-y-1/2 bg-background/80 opacity-0 backdrop-blur transition-opacity group-hover/viewer:opacity-100 focus-visible:opacity-100"
          aria-label={t('images:viewer.previous')}
          onClick={() => step(-1)}
        >
          <IconChevronLeft size={16} />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute right-0 top-1/2 -translate-y-1/2 bg-background/80 opacity-0 backdrop-blur transition-opacity group-hover/viewer:opacity-100 focus-visible:opacity-100"
          aria-label={t('images:viewer.next')}
          onClick={() => step(1)}
        >
          <IconChevronRight size={16} />
        </Button>
      </div>

      {/* The actions for the open image, on their own row under it rather
          than over it. On a narrow canvas the labels fold away and the icons
          stay. */}
      <div className="flex min-w-0 items-center justify-center gap-0.5 [&_button>span]:hidden @[32rem]:[&_button>span]:inline">
        <ImageRecipePopover
          recipe={item.recipe}
          modelDiffers={modelDiffers}
          onRestore={restore}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button
              variant="ghost"
              size="sm"
              aria-label={t('images:viewer.saveAs')}
              onClick={() => void saveAs()}
            >
              <IconDeviceFloppy size={16} />
              <span>{t('images:viewer.saveAs')}</span>
            </Button>
          </TooltipTrigger>
          <TooltipContent>{exportFilename(item)}</TooltipContent>
        </Tooltip>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('images:viewer.useAsSource')}
          onClick={useAsSource}
          data-testid="image-viewer-use-as-source"
        >
          <IconPhotoUp size={16} />
          <span>{t('images:viewer.useAsSource')}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          aria-label={t('images:viewer.reveal')}
          onClick={() => void reveal()}
        >
          <IconFolderOpen size={16} />
          <span>{t('images:viewer.reveal')}</span>
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={requestDelete}
          data-testid="image-viewer-delete"
        >
          <IconTrash size={16} />
          <span>
            {selectedIds.length > 1
              ? t('images:viewer.deleteCount', { count: selectedIds.length })
              : t('images:viewer.delete')}
          </span>
        </Button>
      </div>

      {fullscreen && (
        <div
          className="fixed inset-0 z-100 flex cursor-pointer items-center justify-center bg-black/50 backdrop-blur-md"
          onClick={() => setFullscreen(false)}
          data-testid="image-fullscreen"
        >
          <img
            src={src}
            alt={item.recipe.prompt}
            className="max-h-[90vh] max-w-[90vw] object-contain"
            onClick={(event) => event.stopPropagation()}
          />
        </div>
      )}

      <DeleteGalleryImagesDialog
        ids={pendingDelete}
        onOpenChange={(open) => {
          if (!open) setPendingDelete([])
        }}
      />
    </div>
  )
})

export default ImageViewer
