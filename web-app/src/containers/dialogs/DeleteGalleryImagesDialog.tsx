import { memo, useState } from 'react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { captureImageGalleryAction } from '@/lib/diffusion/telemetry'
import { useImageGalleryStore } from '@/stores/image-gallery-store'

type DeleteGalleryImagesDialogProps = {
  /** Ids to delete; the dialog is open while this is non-empty. */
  ids: string[]
  onOpenChange: (open: boolean) => void
}

/**
 * Confirm-and-delete for one or many gallery images. Deletes the PNGs (and
 * their thumbnails) through the plugin, then drops them from the store so the
 * grid updates without a relisting.
 */
export const DeleteGalleryImagesDialog = memo(
  function DeleteGalleryImagesDialog({
    ids,
    onOpenChange,
  }: DeleteGalleryImagesDialogProps) {
    const { t } = useTranslation()
    const serviceHub = useServiceHub()
    const remove = useImageGalleryStore((state) => state.remove)
    const [deleting, setDeleting] = useState(false)
    const open = ids.length > 0

    const confirm = async () => {
      setDeleting(true)
      try {
        await serviceHub.diffusion().deleteGalleryItems(ids)
        remove(ids)
        captureImageGalleryAction('delete')
        onOpenChange(false)
      } catch (error) {
        toast.error(t('images:delete.failed'), {
          description: error instanceof Error ? error.message : String(error),
        })
      } finally {
        setDeleting(false)
      }
    }

    return (
      <Dialog open={open} onOpenChange={onOpenChange}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {ids.length === 1
                ? t('images:delete.titleOne')
                : t('images:delete.title', { count: ids.length })}
            </DialogTitle>
            <DialogDescription>{t('images:delete.description')}</DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              disabled={deleting}
              onClick={() => onOpenChange(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              disabled={deleting}
              autoFocus
              onClick={() => void confirm()}
              data-testid="gallery-delete-confirm"
            >
              {t('images:delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
)

export default DeleteGalleryImagesDialog
