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
import type { ImageExceedsConfirmation } from '@/hooks/useImageGeneration'
import { useTranslation } from '@/i18n/react-i18next-compat'

const GB = 1024 ** 3

/**
 * "This image likely won't fit in memory" — asked when Generate is pressed
 * with a local model whose estimate at the requested size is a "no"
 * (`useImageGeneration` decides when), the Images twin of the Video page's
 * `ConfirmVideoExceedsMemory`: what it needs against what there is, that it
 * will swap and may stop the engine, and what to change instead. Cancel is
 * the default answer; only "Generate anyway" starts the run.
 */
export function ConfirmImageExceedsMemory({
  open,
  estimate,
  onCancel,
  onConfirm,
}: ImageExceedsConfirmation) {
  const { t } = useTranslation()
  return (
    <Dialog
      open={open}
      onOpenChange={(next) => {
        if (!next) onCancel()
      }}
    >
      <DialogContent data-testid="image-exceeds-dialog">
        <DialogHeader>
          <DialogTitle>{t('images:confirmExceeds.title')}</DialogTitle>
          <DialogDescription>
            {estimate && estimate.budgetBytes !== null
              ? t('images:confirmExceeds.needs', {
                  required: (estimate.residentBytes / GB).toFixed(1),
                  available: (estimate.budgetBytes / GB).toFixed(1),
                })
              : null}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2 text-sm text-muted-foreground">
          <p>{t('images:confirmExceeds.body')}</p>
          <p>{t('images:confirmExceeds.advice')}</p>
        </div>
        <DialogFooter>
          <DialogClose asChild>
            <Button
              variant="ghost"
              size="sm"
              className="w-full sm:w-auto"
              autoFocus
            >
              {t('common:cancel')}
            </Button>
          </DialogClose>
          <Button size="sm" className="w-full sm:w-auto" onClick={onConfirm}>
            {t('images:confirmExceeds.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}

export default ConfirmImageExceedsMemory
