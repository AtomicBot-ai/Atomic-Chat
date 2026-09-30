import { IconQrcode } from '@tabler/icons-react'
import { useState } from 'react'

import { Button } from '@/components/ui/button'
import { CopyButton } from '@/containers/CopyButton'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { queuedCapture } from '@/lib/telemetry-queue'

import { QrCodeDialog } from './QrCodeDialog'

/**
 * One address a client can dial, with the two ways of getting it onto another
 * device. Telemetry says which kind of address was taken, never the address.
 */
export function AccessUrlRow({
  url,
  kind,
}: {
  url: string
  kind: 'remote' | 'lan'
}) {
  const { t } = useTranslation()
  const [qrOpen, setQrOpen] = useState(false)

  return (
    <div
      role="group"
      aria-label={url}
      className="flex items-center gap-1 rounded-md border border-border/60 bg-background/50 py-1 pl-3 pr-1"
    >
      <code className="min-w-0 flex-1 break-all font-mono text-xs text-foreground select-text">
        {url}
      </code>
      <CopyButton
        text={url}
        ariaLabel={t('settings:remoteLan.copyUrl')}
        onCopied={() => queuedCapture('access_url_copy', { access_kind: kind })}
      />
      <Button
        variant="ghost"
        size="icon-xs"
        aria-label={t('settings:remoteLan.qr.show')}
        onClick={() => {
          setQrOpen(true)
          queuedCapture('access_qr_open', { access_kind: kind })
        }}
      >
        <IconQrcode size={16} />
      </Button>
      <QrCodeDialog
        open={qrOpen}
        onOpenChange={setQrOpen}
        url={url}
        description={t(
          kind === 'remote'
            ? 'settings:remoteLan.qr.remoteDesc'
            : 'settings:remoteLan.qr.lanDesc'
        )}
      />
    </div>
  )
}
