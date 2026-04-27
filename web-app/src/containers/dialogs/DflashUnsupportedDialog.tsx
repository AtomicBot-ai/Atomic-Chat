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
          <DialogTitle className="font-bold">
            {t('settings:dflashUnsupportedTitle', {
              defaultValue: "DFlash isn't available for this model",
            })}
          </DialogTitle>
          <DialogDescription>
            {/* Composed manually instead of via i18n placeholders so the
                inline link to the z-lab/dflash collection stays a real
                anchor element (the t() return is a plain string). */}
            <span>
              {t('settings:dflashUnsupportedDescPrefix', {
                defaultValue:
                  "{{modelId}} doesn't have a paired draft model. Pick a supported one from the ",
                modelId,
              })}
            </span>
            <a
              href="https://huggingface.co/collections/z-lab/dflash"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#1F7CFF' }}
              /* `whitespace-nowrap` keeps "z-lab/dflash" on a single line:
                 the slash is otherwise a soft-wrap point, so the link
                 used to split as "z-lab/" + "dflash". Now it wraps as a
                 whole unit to the next line when it doesn't fit. */
              className="underline underline-offset-2 whitespace-nowrap"
            >
              z-lab/dflash
            </a>
            <span>
              {t('settings:dflashUnsupportedDescSuffix', {
                defaultValue:
                  ' collection to enable faster generation.',
              })}
            </span>
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
