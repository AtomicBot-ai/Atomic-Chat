import { useEffect, useState } from 'react'
import { IconExternalLink, IconLoader2 } from '@tabler/icons-react'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { Input } from '@/components/ui/input'
import type { MCPConnector } from '@/constants/mcp-connectors'
import { useTranslation } from '@/i18n/react-i18next-compat'

/**
 * One-field setup dialog for catalog connectors that need a secret (API key
 * or token). The parent runs the install and closes the dialog only on
 * success, so a failed attempt keeps the value editable for a retry.
 */
export default function ConnectorSecretDialog({
  open,
  onOpenChange,
  connector,
  busy,
  onConnect,
}: {
  open: boolean
  onOpenChange: (open: boolean) => void
  connector: MCPConnector | null
  busy: boolean
  onConnect: (value: string) => void
}) {
  const { t } = useTranslation()
  const [value, setValue] = useState('')

  useEffect(() => {
    if (open) setValue('')
  }, [open, connector?.serverKey])

  const secret = connector?.secret
  if (!connector || !secret) return null

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent>
        <DialogHeader>
          <DialogTitle>
            {t('mcp-connectors:secretDialog.title', { name: connector.name })}
          </DialogTitle>
          <DialogDescription>
            {t('mcp-connectors:secretDialog.desc')}
          </DialogDescription>
        </DialogHeader>
        <div className="space-y-2">
          <label className="text-sm mb-2 inline-block">{t(secret.labelKey)}</label>
          <Input
            type="password"
            value={value}
            onChange={(e) => setValue(e.target.value)}
            placeholder={secret.placeholder}
            autoFocus
          />
          {secret.helpUrl && (
            <a
              href={secret.helpUrl}
              target="_blank"
              rel="noopener noreferrer"
              className="flex items-center gap-1 text-sm text-primary hover:underline"
            >
              {t('mcp-connectors:secretDialog.getKey')}
              <IconExternalLink size={14} />
            </a>
          )}
        </div>
        <DialogFooter>
          <Button
            variant="ghost"
            size="sm"
            onClick={() => onOpenChange(false)}
            disabled={busy}
          >
            {t('common:cancel')}
          </Button>
          <Button
            size="sm"
            className="gap-1.5"
            disabled={value.trim() === '' || busy}
            onClick={() => onConnect(value)}
          >
            {busy && <IconLoader2 size={14} className="animate-spin" />}
            {t('mcp-connectors:secretDialog.connect')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
