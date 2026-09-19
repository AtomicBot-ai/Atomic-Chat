import { useRef, useState } from 'react'
import { IconLoader2 } from '@tabler/icons-react'
import { toast } from 'sonner'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogTrigger,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogClose,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface FactoryResetDialogProps {
  onReset: () => void | Promise<void>
  children: React.ReactNode
}

export function FactoryResetDialog({
  onReset,
  children,
}: FactoryResetDialogProps) {
  const { t } = useTranslation()
  const resetButtonRef = useRef<HTMLButtonElement>(null)
  const [isOpen, setIsOpen] = useState(false)
  const [isResetting, setIsResetting] = useState(false)

  const handleReset = async () => {
    if (isResetting) return

    setIsResetting(true)
    try {
      await onReset()
      setIsOpen(false)
    } catch (error) {
      toast.error(t('settings:general.factoryResetFailed'))
      console.error('Factory reset failed:', error)
    } finally {
      setIsResetting(false)
    }
  }

  return (
    <Dialog
      open={isOpen}
      onOpenChange={(open) => {
        if (!isResetting || !open) {
          setIsOpen(open)
        }
      }}
    >
      <DialogTrigger asChild>{children}</DialogTrigger>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          resetButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('settings:general.factoryResetTitle')}</DialogTitle>
          <DialogDescription>
            {t('settings:general.factoryResetDesc')}
          </DialogDescription>
          <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
            <DialogClose asChild>
              <Button
                variant="ghost"
                size="sm"
                className="hover:no-underline w-full sm:w-auto"
                disabled={isResetting}
              >
                {t('settings:general.cancel')}
              </Button>
            </DialogClose>
            <Button
              ref={resetButtonRef}
              variant="destructive"
              onClick={() => void handleReset()}
              size="sm"
              className="w-full sm:w-auto"
              aria-label={t('settings:general.reset')}
              aria-busy={isResetting}
              disabled={isResetting}
            >
              {isResetting && (
                <IconLoader2 className="size-4 animate-spin" aria-hidden="true" />
              )}
              {t('settings:general.reset')}
            </Button>
            {isResetting && (
              <span className="sr-only" role="status" aria-live="polite">
                {t('common:loading')}
              </span>
            )}
          </DialogFooter>
        </DialogHeader>
      </DialogContent>
    </Dialog>
  )
}
