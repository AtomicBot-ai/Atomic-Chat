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
import { captureVideoGalleryAction } from '@/lib/diffusion/telemetry'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'

type DeleteGalleryVideosDialogProps = {
  /** Ids to delete; the dialog is open while this is non-empty. */
  ids: string[]
  onOpenChange: (open: boolean) => void
}

/**
 * Confirm-and-delete for one or many gallery clips. Deletes the WebM, its
 * recipe and its poster through the core, then drops them from the store so
 * the grid updates without a relisting.
 */
export const DeleteGalleryVideosDialog = memo(
  function DeleteGalleryVideosDialog({
    ids,
    onOpenChange,
  }: DeleteGalleryVideosDialogProps) {
    const { t } = useTranslation()
    const serviceHub = useServiceHub()
    const remove = useVideoGalleryStore((state) => state.remove)
    const [deleting, setDeleting] = useState(false)
    const open = ids.length > 0

    const confirm = async () => {
      setDeleting(true)
      try {
        await serviceHub.diffusion().deleteVideoGalleryItems(ids)
        remove(ids)
        captureVideoGalleryAction('delete')
        onOpenChange(false)
      } catch (error) {
        toast.error(t('videos:delete.failed'), {
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
                ? t('videos:delete.titleOne')
                : t('videos:delete.title', { count: ids.length })}
            </DialogTitle>
            <DialogDescription>{t('videos:delete.description')}</DialogDescription>
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
              {t('videos:delete.confirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    )
  }
)

export default DeleteGalleryVideosDialog
