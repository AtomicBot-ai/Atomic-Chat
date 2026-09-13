import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
  DialogTrigger,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'

type Props = {
  /** Nothing is off its default, so there is nothing to reset. */
  disabled: boolean
  onReset: () => void
}

/**
 * "Reset settings" for a local engine's page, behind a confirmation: it
 * also clears what was typed into free-form fields such as extra arguments.
 */
export function ResetEngineSettings({ disabled, onReset }: Props) {
  const { t } = useTranslation()

  return (
    <Dialog>
      <DialogTrigger asChild>
        <Button variant="secondary" size="sm" disabled={disabled}>
          {t('providers:resetEngineSettings.reset')}
        </Button>
      </DialogTrigger>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('providers:resetEngineSettings.confirmTitle')}
          </DialogTitle>
          <DialogDescription>
            {t('providers:resetEngineSettings.confirmDescription')}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="mt-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="hover:no-underline">
              {t('providers:resetEngineSettings.cancel')}
            </Button>
          </DialogClose>
          <DialogClose asChild>
            <Button size="sm" onClick={onReset}>
              {t('providers:resetEngineSettings.confirm')}
            </Button>
          </DialogClose>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
