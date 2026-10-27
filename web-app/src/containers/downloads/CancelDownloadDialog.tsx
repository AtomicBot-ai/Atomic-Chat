import { shortModelName } from '@/lib/downloadFormat'
import { Button } from '@/components/ui/button'
import { Dialog, DialogContent, DialogDescription, DialogFooter, DialogHeader, DialogTitle } from '@/components/ui/dialog'
import { useTranslation } from '@/i18n/react-i18next-compat'

export function CancelDownloadDialog({ name, busy, error, canDeleteFiles, onBack, onKeep, onDeleteFiles }: {
  name?: string; busy: boolean; error?: string; canDeleteFiles: boolean
  onBack: () => void; onKeep: () => void; onDeleteFiles: () => void
}) {
  const { t } = useTranslation()
  return <Dialog open={!!name} onOpenChange={(open) => { if (!open && !busy) onBack() }}>
    <DialogContent className="max-h-[85vh] overflow-y-auto" onEscapeKeyDown={(event) => { if (busy) event.preventDefault() }} onInteractOutside={(event) => { if (busy) event.preventDefault() }}>
      <DialogHeader>
        <DialogTitle>{t('common:cancelDownloadDialog.title')}</DialogTitle>
        <DialogDescription>{t('common:cancelDownloadDialog.description')}</DialogDescription>
      </DialogHeader>
      <p className="min-w-0 break-all text-sm">{name ? shortModelName(name) : ''}</p>
      {!canDeleteFiles && <p className="text-sm text-muted-foreground">{t('common:cancelDownloadDialog.unsupported')}</p>}
      {error && <p role="alert" className="break-words text-sm text-destructive">{t('common:cancelDownloadDialog.failed')}<span className="mt-2 block text-xs">{error}</span></p>}
      <DialogFooter className="flex-col gap-2 sm:flex-col sm:items-stretch">
        <Button className="h-auto min-h-9 whitespace-normal py-2" variant="outline" disabled={busy} onClick={onKeep}>{t('common:cancelDownloadDialog.keep')}</Button>
        <Button className="h-auto min-h-9 whitespace-normal py-2" variant="destructive" disabled={busy || !canDeleteFiles} onClick={onDeleteFiles}>{t(busy ? 'common:cancelDownloadDialog.busy' : 'common:cancelDownloadDialog.delete')}</Button>
        <Button className="h-auto min-h-9 whitespace-normal py-2" variant="ghost" disabled={busy} onClick={onBack}>{t('common:cancelDownloadDialog.back')}</Button>
      </DialogFooter>
    </DialogContent>
  </Dialog>
}
