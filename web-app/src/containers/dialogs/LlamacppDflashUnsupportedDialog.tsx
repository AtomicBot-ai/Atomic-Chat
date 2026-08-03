import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  Dialog,
  DialogContent,
  DialogTitle,
  DialogDescription,
  DialogFooter,
  DialogHeader,
} from '@/components/ui/dialog'
import { Button } from '@/components/ui/button'

interface LlamacppDflashUnsupportedDialogProps {
  open: boolean
  onOpenChange: (open: boolean) => void
  modelId: string
}

/// Shown when the user flips the upstream-llama `dflash` toggle on while the
/// active llama.cpp model is not a DFlash-capable target in the registry.
/// DFlash needs a separate multi-layer draft GGUF paired with the target;
/// only the listed families have such a draft published.
export function LlamacppDflashUnsupportedDialog({
  open,
  onOpenChange,
  modelId,
}: LlamacppDflashUnsupportedDialogProps) {
  const { t } = useTranslation()

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent className="sm:max-w-[460px] max-w-[90vw]">
        <DialogHeader>
          <DialogTitle className="font-bold">
            {t('settings:llamacppDflashUnsupportedTitle', {
              defaultValue: "DFlash isn't available for this model",
            })}
          </DialogTitle>
          <DialogDescription>
            {/* Composed manually instead of via i18n placeholders so the
                inline links to the supported DFlash repos stay real anchor
                elements (the t() return is a plain string). */}
            <span>
              {t('settings:llamacppDflashUnsupportedDescPrefix', {
                defaultValue:
                  '{{modelId}} is not a DFlash-capable target. DFlash requires a paired draft GGUF, which is downloaded automatically for the following models: ',
                modelId,
              })}
            </span>
            <a
              href="https://huggingface.co/onion515/Qwen3.5-9B-DFlash-GGUF"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#1F7CFF' }}
              className="underline underline-offset-2 whitespace-nowrap"
            >
              Qwen3.5-9B
            </a>
            <span>, </span>
            <a
              href="https://huggingface.co/williamliao/qwen3.6-27B-DFlash-GGUF"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#1F7CFF' }}
              className="underline underline-offset-2 whitespace-nowrap"
            >
              Qwen3.6-27B
            </a>
            <span> {t('common:and', { defaultValue: 'and' })} </span>
            <a
              href="https://huggingface.co/williamliao/Qwen3.6-35B-A3B-DFlash-GGUF"
              target="_blank"
              rel="noopener noreferrer"
              style={{ color: '#1F7CFF' }}
              className="underline underline-offset-2 whitespace-nowrap"
            >
              Qwen3.6-35B-A3B
            </a>
            <span>
              {t('settings:llamacppDflashUnsupportedDescSuffix', {
                defaultValue:
                  '. Load one of these to enable DFlash speculative decoding.',
              })}
            </span>
          </DialogDescription>
        </DialogHeader>
        <DialogFooter className="flex flex-col-reverse sm:flex-row sm:justify-end gap-2">
          <Button
            size="sm"
            onClick={() => onOpenChange(false)}
            className="w-full sm:w-auto"
          >
            {t('common:ok', { defaultValue: 'OK' })}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
