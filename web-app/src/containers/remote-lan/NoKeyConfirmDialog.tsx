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

/**
 * Shown when Remote access is started with no API key. Exposing the API
 * without one is allowed — the user's call — but it takes a deliberate yes,
 * and the safer way out is one click away.
 *
 * The actions stack: "Generate key and start" does not fit on one row with two
 * more buttons once it is translated.
 */
export function NoKeyConfirmDialog({
  open,
  onGenerateKey,
  onStartWithoutKey,
  onCancel,
}: {
  open: boolean
  onGenerateKey: () => void
  onStartWithoutKey: () => void
  onCancel: () => void
}) {
  const { t } = useTranslation()

  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        // Escape, the overlay and the close button all mean "not now".
        if (!next) onCancel()
      }}
    >
      <DialogContent>
        <DialogHeader>
          <DialogTitle>{t('settings:remoteLan.noKeyDialog.title')}</DialogTitle>
          <DialogDescription>
            {t('settings:remoteLan.noKeyDialog.description')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="sm:flex-col-reverse sm:justify-start">
          <Button
            variant="link"
            size="sm"
            className="w-full hover:no-underline"
            onClick={onCancel}
          >
            {t('settings:remoteLan.noKeyDialog.cancel')}
          </Button>
          <Button
            variant="outline"
            size="sm"
            className="w-full"
            onClick={onStartWithoutKey}
          >
            {t('settings:remoteLan.noKeyDialog.startWithoutKey')}
          </Button>
          <Button size="sm" className="w-full" onClick={onGenerateKey}>
            {t('settings:remoteLan.noKeyDialog.generateAndStart')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
