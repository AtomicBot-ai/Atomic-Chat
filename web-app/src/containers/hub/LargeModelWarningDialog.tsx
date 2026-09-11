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

export type LargeModelWarningDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The user read the warning and wants the download anyway. */
  onConfirm: () => void
}

/**
 * "This may not run here" — asked before downloading a variant the hardware-fit
 * estimate calls too large.
 *
 * The estimate is the file size against the device's memory, not a
 * measurement, so the Hub warns and lets the user decide where it used to
 * disable the Download button outright.
 */
export function LargeModelWarningDialog({
  open,
  onOpenChange,
  onConfirm,
}: LargeModelWarningDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('hub:tooLargeTitle')}</DialogTitle>
          <DialogDescription>{t('hub:tooLargeDescription')}</DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <Button variant="ghost" size="sm" onClick={() => onOpenChange(false)}>
            {t('common:cancel')}
          </Button>
          <Button variant="default" size="sm" autoFocus onClick={onConfirm}>
            {t('hub:downloadAnyway')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
