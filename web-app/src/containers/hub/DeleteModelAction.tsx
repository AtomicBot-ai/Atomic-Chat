import { useCallback, useState } from 'react'
import { IconTrash } from '@tabler/icons-react'
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
import { deleteLocalModel } from '@/lib/model-deletion'

export type DeleteModelActionProps = {
  /** Id the engine registered the model under, not the catalog's spelling. */
  modelId: string
  /** Local provider that owns the files (`llamacpp*` / `mlx`). */
  provider: string
  /** Called after the files are gone, before the provider list is refreshed. */
  onDeleted?: () => void
}

/**
 * Trash button + confirmation for a model installed on this device.
 *
 * Until now removing a download was only reachable from Settings → Model
 * Providers, which is nowhere near where the user downloaded it. This is the
 * same operation, rendered next to the Hub's download/"New chat" action.
 */
export function DeleteModelAction({
  modelId,
  provider,
  onDeleted,
}: DeleteModelActionProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()

  const [open, setOpen] = useState(false)
  const [deleting, setDeleting] = useState(false)

  const handleDelete = useCallback(async () => {
    setDeleting(true)
    try {
      await deleteLocalModel(serviceHub, modelId, provider)
      onDeleted?.()
      toast.success(t('common:deleteModel.title', { modelId }), {
        id: `delete-model-${modelId}`,
        description: t('common:deleteModel.success', { modelId }),
      })
      setOpen(false)
    } catch (error) {
      console.error('[DeleteModelAction] deleteModel failed:', error)
      toast.error(t('common:deleteModel.title', { modelId }), {
        id: `delete-model-${modelId}`,
        description: error instanceof Error ? error.message : String(error),
      })
    } finally {
      setDeleting(false)
    }
  }, [modelId, onDeleted, provider, serviceHub, t])

  return (
    <Dialog open={open} onOpenChange={setOpen}>
      <Button
        type="button"
        variant="ghost"
        size="icon-sm"
        onClick={() => setOpen(true)}
        title={t('common:deleteModel.delete')}
        aria-label={t('common:deleteModel.delete')}
        className="shrink-0 text-muted-foreground hover:text-destructive"
      >
        <IconTrash size={16} />
      </Button>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('common:deleteModel.title', { modelId })}
          </DialogTitle>
          <DialogDescription>
            {t('common:deleteModel.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={deleting}
            onClick={() => setOpen(false)}
          >
            {t('common:deleteModel.cancel')}
          </Button>
          <Button
            variant="destructive"
            size="sm"
            autoFocus
            disabled={deleting}
            onClick={handleDelete}
          >
            {t('common:deleteModel.delete')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
