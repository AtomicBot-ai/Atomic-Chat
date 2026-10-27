import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { EngineDetail } from '@/containers/engines/EngineDetail'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { getProviderTitle } from '@/lib/utils'

/**
 * Server → Engine & model → the gear beside the engine: that engine's
 * settings, the ones its card unfolds on Models Hub → Inference engines, in a
 * dialog over the page. They are saved as they change, as they are there, so
 * the dialog closes with Done rather than a save of its own.
 */
export function ServerEngineConfigDialog({
  provider,
  onClose,
}: {
  provider: string
  onClose: () => void
}) {
  const { t } = useTranslation()
  const title = getProviderTitle(provider)
  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) onClose()
      }}
    >
      <DialogContent
        className="flex flex-col overflow-hidden sm:max-w-3xl lg:max-w-3xl xl:max-w-3xl"
        data-testid="server-engine-config"
      >
        <DialogHeader>
          <DialogTitle>
            {t('api:model.engineConfigTitle', { name: title })}
          </DialogTitle>
          <DialogDescription>{t('api:model.engineConfigHint')}</DialogDescription>
        </DialogHeader>
        <div className="-mr-2 min-h-0 overflow-y-auto pr-2">
          <EngineDetail providerName={provider} embedded engineSwitch={false} />
        </div>
        <DialogFooter className="shrink-0 border-t pt-4">
          <Button onClick={onClose}>{t('api:model.engineConfigDone')}</Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
