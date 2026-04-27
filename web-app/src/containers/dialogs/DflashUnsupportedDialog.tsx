import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface DflashUnsupportedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  modelId: string
}

export function DflashUnsupportedDialog({
  open,
  onOpenChange,
  modelId,
}: DflashUnsupportedDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle>
            {t('settings:dflashUnsupportedTitle', {
              defaultValue: 'DFlash is not available',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('settings:dflashUnsupportedDesc', {
              defaultValue:
                'The currently running model "{{modelId}}" does not have a matching draft in the z-lab/dflash collection. Switch to a supported model and try again.',
              modelId,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto"
          >
            {t('common:ok', { defaultValue: 'OK' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
