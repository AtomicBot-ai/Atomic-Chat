import { memo, useCallback, useEffect, useState } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import {
  IconChevronLeft,
  IconChevronRight,
  IconDeviceFloppy,
  IconFolderOpen,
  IconMaximize,
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
  const serviceHub = useServiceHub()
  const step = useImageGalleryStore((state) => state.step)
  const applyDraft = useImageForm((state) => state.applyDraft)
  const runs = useImageForm((state) => state.runs)
  const selectedArtifactId = useImageSetting((state) => state.selectedArtifactId)
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
        className="flex h-full min-h-48 items-center justify-center text-sm text-muted-foreground"
        data-testid="image-viewer-empty"
      >
        {t('images:viewer.empty')}
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
    <div className="flex h-full flex-col gap-2" data-testid="image-viewer">
      <div className="relative flex min-h-0 flex-1 items-center justify-center overflow-hidden rounded-lg bg-secondary/40">
        <button
          type="button"
          className="size-full cursor-zoom-in"
          aria-label={t('images:viewer.fullscreen')}
          onClick={() => {
            setFullscreen(true)
            captureImageGalleryAction('open')
          }}
        >
          <img
            src={src}
            alt={item.recipe.prompt}
            decoding="async"
            draggable={false}
            className="size-full object-contain"
          />
        </button>
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute left-2 top-1/2 -translate-y-1/2 bg-background/80"
          aria-label={t('images:viewer.previous')}
          onClick={() => step(-1)}
        >
          <IconChevronLeft size={16} />
        </Button>
        <Button
          variant="outline"
          size="icon-sm"
          className="absolute right-2 top-1/2 -translate-y-1/2 bg-background/80"
          aria-label={t('images:viewer.next')}
          onClick={() => step(1)}
        >
          <IconChevronRight size={16} />
        </Button>
      </div>

      <div className="flex flex-wrap items-center gap-1">
        <ImageRecipePopover
          recipe={item.recipe}
          modelDiffers={modelDiffers}
          onRestore={restore}
        />
        <Tooltip>
          <TooltipTrigger asChild>
            <Button variant="ghost" size="sm" onClick={() => void saveAs()}>
              <IconDeviceFloppy size={16} />
              {t('images:viewer.saveAs')}
            </Button>
          </TooltipTrigger>
          <TooltipContent>{exportFilename(item)}</TooltipContent>
        </Tooltip>
        <Button variant="ghost" size="sm" onClick={() => void reveal()}>
          <IconFolderOpen size={16} />
          {t('images:viewer.reveal')}
        </Button>
        <Button
          variant="ghost"
          size="sm"
          className="text-destructive hover:text-destructive"
          onClick={requestDelete}
          data-testid="image-viewer-delete"
        >
          <IconTrash size={16} />
          {selectedIds.length > 1
            ? t('images:viewer.deleteCount', { count: selectedIds.length })
            : t('images:viewer.delete')}
        </Button>
        <span className="ml-auto font-mono text-xs tabular-nums text-muted-foreground">
          {item.width}×{item.height}
        </span>
        <Button
          variant="ghost"
          size="icon-sm"
          aria-label={t('images:viewer.fullscreen')}
          onClick={() => setFullscreen(true)}
        >
          <IconMaximize size={16} />
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
