import QRCode from 'react-qr-code'

import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * Carries an address to another device without retyping it. The URL is
 * repeated as text under the code, for whoever would rather read it across.
 */
export function QrCodeDialog({
  open,
  onOpenChange,
  url,
  description,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  url: string
  description: string
}) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-xs lg:max-w-xs xl:max-w-xs">
        <DialogHeader>
          <DialogTitle>{t('settings:remoteLan.qr.title')}</DialogTitle>
          <DialogDescription>{description}</DialogDescription>
        </DialogHeader>
        {/* Always a white plate with a quiet zone: a scanner needs dark
            modules on a light ground, whatever theme the app is in. */}
        <div
          data-testid="access-qr-code"
          className="mx-auto rounded-lg bg-white p-3"
        >
          <QRCode value={url} size={192} />
        </div>
        <code className="block break-all text-center font-mono text-xs text-muted-foreground select-text">
          {url}
        </code>
      </DialogContent>
    </Dialog>
  )
}
