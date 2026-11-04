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
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

type DeleteAudioClipDialogProps = {
  /** The clip to delete; the dialog is open while this is set. */
  id: string | null
  onClose: () => void
}

/** Confirm-and-delete for a gallery clip: the core removes the WAV and its recipe. */
export const DeleteAudioClipDialog = memo(function DeleteAudioClipDialog({
  id,
  onClose,
}: DeleteAudioClipDialogProps) {
  const { t } = useTranslation()
  const deleteClip = useAudioGenerationStore((state) => state.deleteClip)
  const [deleting, setDeleting] = useState(false)

  const confirm = async () => {
    if (!id) return
    setDeleting(true)
    try {
      await deleteClip(id)
      onClose()
    } catch (error) {
      toast.error(t('audios:delete.failed'), {
        description:
          (error as { message?: string } | null)?.message ?? String(error),
      })
    } finally {
      setDeleting(false)
    }
  }

  return (
    <Dialog open={id !== null} onOpenChange={(open) => !open && onClose()}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('audios:delete.title')}</DialogTitle>
          <DialogDescription>
            {t('audios:delete.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={onClose}
          >
            {t('common:cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            disabled={deleting}
            autoFocus
            onClick={() => void confirm()}
            data-testid="audio-delete-confirm"
          >
            {t('audios:delete.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
})
