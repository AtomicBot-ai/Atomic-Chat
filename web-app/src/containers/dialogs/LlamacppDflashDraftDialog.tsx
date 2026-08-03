import { useEffect, useMemo, useState } from 'react'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'
import { ModelLogo } from '@/containers/ModelLogo'

export interface LlamacppDflashDraftOption {
  quant: string
  repo: string
  draftFilename: string
  draftSize: number
}

interface LlamacppDflashDraftDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  modelId: string
  options: readonly LlamacppDflashDraftOption[]
  onConfirm: (quant: string) => void
}

function formatSize(bytes: number): string {
  const gib = bytes / 1024 ** 3
  return gib >= 1 ? `${gib.toFixed(1)} GB` : `${Math.round(bytes / 1024 ** 2)} MB`
}

export function LlamacppDflashDraftDialog({
  open,
  onOpenChange,
  modelId,
  options,
  onConfirm,
}: LlamacppDflashDraftDialogProps) {
  const { t } = useTranslation()
  const defaultQuant = useMemo(
    () => options.find((option) => option.quant === 'Q8_0')?.quant ?? options[0]?.quant ?? '',
    [options]
  )
  const [selectedQuant, setSelectedQuant] = useState(defaultQuant)

  useEffect(() => {
    if (open) setSelectedQuant(defaultQuant)
  }, [defaultQuant, open])

  const selected =
    options.find((option) => option.quant === selectedQuant) ?? options[0]

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[480px] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="font-bold">
            {t('settings:llamacppDflashDraftTitle', {
              defaultValue: 'Choose DFlash draft quantization',
            })}
          </DialogTitle>
          <DialogDescription>
            {t('settings:llamacppDflashDraftDesc', {
              defaultValue:
                'Select the additional draft GGUF to pair with {{modelId}}. Atomic Chat Q8_0 is selected by default when available.',
              modelId,
            })}
          </DialogDescription>
        </DialogHeader>

        {selected && (
          <div className="flex items-center gap-3 rounded-lg border border-border p-3">
            <ModelLogo
              author={selected.repo.split('/')[0]}
              name={selected.repo}
              className="size-9 rounded-lg"
            />
            <div className="min-w-0 flex-1">
              <p className="truncate text-sm font-medium text-foreground">
                {selected.repo.split('/').pop()}
              </p>
              <p className="truncate text-xs text-muted-foreground">
                {selected.repo.split('/')[0]} · {formatSize(selected.draftSize)}
              </p>
            </div>
            <select
              aria-label={t('settings:llamacppDflashDraftQuantLabel', {
                defaultValue: 'Draft quantization',
              })}
              value={selected.quant}
              onChange={(event) => setSelectedQuant(event.target.value)}
              className="h-8 shrink-0 rounded-md border border-border bg-transparent px-2 text-xs text-foreground focus:outline-none focus:ring-1 focus:ring-ring"
            >
              {options.map((option) => (
                <option key={option.quant} value={option.quant}>
                  {option.quant} · {formatSize(option.draftSize)}
                </option>
              ))}
            </select>
          </div>
        )}

        <DialogFooter className="flex flex-col-reverse gap-2 sm:flex-row sm:justify-end">
          <Button
            variant="outline"
            size="sm"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto"
          >
            {t('common:cancel', { defaultValue: 'Cancel' })}
          </Button>
          <Button
            size="sm"
            disabled={!selected}
            onClick={() => {
              if (!selected) return
              onOpenChange(false)
              onConfirm(selected.quant)
            }}
            className="w-full sm:w-auto"
          >
            {t('settings:llamacppDflashDraftDownload', {
              defaultValue: 'Download and enable',
            })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
