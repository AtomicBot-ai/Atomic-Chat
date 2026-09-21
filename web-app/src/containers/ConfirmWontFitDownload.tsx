import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { WontFitConfirmation } from '@/hooks/useConfirmWontFitDownload'

/**
 * "This model won't fit in memory" — asked before a red row's download
 * starts, and only then; `useConfirmWontFitDownload` decides when. Cancel is
 * the default answer, so Enter and Escape both leave the row as it was; only
 * "Download anyway" starts the transfer, which then runs its own disk-space
 * check as any download does.
 */
export function ConfirmWontFitDownload({
  open,
  download,
  onCancel,
  onConfirm,
}: WontFitConfirmation) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('setup:wontFitDialog.title')}</DialogTitle>
          {/* The row again — the name, then the mark's sentence, which opens
              with the size — so the user knows which click this is about. */}
          <DialogDescription>
            <span className="font-medium text-foreground">
              {download?.name}
            </span>
            {download?.reason ? ` · ${download.reason}` : null}
          </DialogDescription>
        </DialogHeader>
        <p className="text-sm text-muted-foreground">
          {t('setup:wontFitDialog.body')}
        </p>
        <DialogFooter>
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="w-full sm:w-auto">
              {t('common:cancel')}
            </Button>
          </DialogClose>
          <Button size="sm" className="w-full sm:w-auto" onClick={onConfirm}>
            {t('setup:wontFitDialog.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
