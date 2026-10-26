import { useRef, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogClose,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface RemoveProjectFileDialogProps {
  /** The file asked about; the dialog is open while one is set. */
  fileName: string | null
  onOpenChange: (open: boolean) => void
  onConfirm: () => void
}

/**
 * Asks before a file leaves a project's index, as deleting a chat, a project
 * or an assistant does. Removing it drops the indexed copy only: the file on
 * disk stays, but chats stop finding it until it is uploaded and indexed
 * again.
 */
export function RemoveProjectFileDialog({
  fileName,
  onOpenChange,
  onConfirm,
}: RemoveProjectFileDialogProps) {
  const { t } = useTranslation()
  const removeButtonRef = useRef<HTMLButtonElement>(null)
  // Keeps the name on screen while the dialog animates closed.
  const [shownName, setShownName] = useState(fileName ?? '')
  if (fileName !== null && fileName !== shownName) setShownName(fileName)

  return (
    <Dialog open={fileName !== null} onOpenChange={onOpenChange}>
      <DialogContent
        onOpenAutoFocus={(e) => {
          e.preventDefault()
          removeButtonRef.current?.focus()
        }}
      >
        <DialogHeader>
          <DialogTitle>{t('common:files.removeTitle')}</DialogTitle>
          <DialogDescription className="break-words">
            {t('common:files.removeDescription', {
              fileName: shownName,
            })}
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <DialogClose asChild>
            <Button variant="ghost" size="sm" className="w-full sm:w-auto">
              {t('common:cancel')}
            </Button>
          </DialogClose>
          <Button
            ref={removeButtonRef}
            variant="destructive"
            size="sm"
            className="w-full sm:w-auto"
            onClick={onConfirm}
          >
            {t('common:files.remove')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
