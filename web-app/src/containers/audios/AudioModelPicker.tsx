import { memo, useMemo, useState } from 'react'
import {
  IconCheck,
  IconChevronDown,
  IconDownload,
  IconTrash,
  IconX,
} from '@tabler/icons-react'
import { AudioLines } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { MediaModelPickerButton } from '@/containers/images/MediaStudio'
import { useAudioGeneration } from '@/hooks/useAudioGeneration'
import { useAudioModel } from '@/hooks/useAudioModel'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn, formatBytes } from '@/lib/utils'
import {
  audioModelsOf,
  type AudioCatalogModel,
} from '@/services/audio-catalog-registry'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

/** "Powered by Stability AI": the catalog's words, wherever the model is offered or used. */
export function AudioAttribution({
  text,
  className,
}: {
  text: string | null
  className?: string
}) {
  if (!text) return null
  return (
    <p
      className={cn('text-[11px] leading-3 text-muted-foreground', className)}
      data-testid="audio-attribution"
    >
      {text}
    </p>
  )
}

function ModelRow({
  model,
  selected,
  canDownload,
  onPick,
}: {
  model: AudioCatalogModel
  selected: boolean
  canDownload: boolean
  onPick: (installed: boolean) => void
}) {
  const { t } = useTranslation()
  const state = useAudioModel(model)
  const [confirmRemove, setConfirmRemove] = useState(false)
  const percent = Math.round(state.progress * 100)

  return (
    <div
      className="my-1 flex items-center gap-2 rounded-xl border p-3"
      data-testid={`audio-model-${model.id}`}
    >
      <button
        type="button"
        className="flex min-w-0 flex-1 items-center gap-3 text-left"
        aria-pressed={selected}
        onClick={() => onPick(state.installed)}
      >
        <AudioLines size={24} className="shrink-0 text-muted-foreground" />
        <span className="min-w-0 flex-1 space-y-0.5">
          <strong className="block truncate text-sm font-medium">
            {model.name}
          </strong>
          <span className="block truncate text-xs text-muted-foreground">
            {[
              t(`audios:mode.${model.mode}.title`),
              formatBytes(state.quant.bytes),
              model.license,
            ].join(' · ')}
          </span>
          <span className="block text-[11px] leading-snug text-muted-foreground">
            {model.description}
          </span>
          <AudioAttribution text={model.attribution} className="pt-0.5" />
        </span>
        {selected && <IconCheck size={16} className="shrink-0" />}
      </button>
      {/* One slot for every state, so a row never changes width. */}
      <div
        className="flex w-28 shrink-0 items-center justify-end gap-1"
        data-testid="audio-model-action"
      >
        {state.downloading ? (
          <Button
            type="button"
            variant="outline"
            size="sm"
            onClick={() => void state.cancelDownload()}
            aria-label={t('common:cancelDownload')}
            className="group relative w-full justify-center overflow-hidden font-semibold"
          >
            <span
              className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
              style={{ width: `${percent}%` }}
            />
            <span className="relative z-10 tabular-nums group-hover:hidden">
              {percent}%
            </span>
            <IconX
              size={14}
              className="relative z-10 hidden group-hover:block"
            />
          </Button>
        ) : state.installed ? (
          // The inset keeps the trash button's hit area inside the slot.
          <div className="flex min-w-0 items-center gap-1 pr-1">
            <span className="truncate text-xs text-muted-foreground">
              {t('audios:model.downloaded')}
            </span>
            <Button
              type="button"
              variant="ghost"
              size="icon-xs"
              className="hit-area-15 relative"
              aria-label={t('audios:model.remove', { name: model.name })}
              onClick={() => setConfirmRemove(true)}
            >
              <IconTrash size={14} />
            </Button>
          </div>
        ) : (
          <Button
            type="button"
            variant="outline"
            size="sm"
            className="w-full"
            disabled={!canDownload}
            aria-label={t('audios:model.download', { name: model.name })}
            onClick={() => void state.download()}
          >
            <IconDownload size={14} />
            <span className="truncate">{t('audios:model.downloadShort')}</span>
          </Button>
        )}
      </div>
      <Dialog open={confirmRemove} onOpenChange={setConfirmRemove}>
        <DialogContent>
          <DialogHeader>
            <DialogTitle>
              {t('audios:model.removeTitle', { name: model.name })}
            </DialogTitle>
            <DialogDescription>
              {t('audios:model.removeDescription', {
                size: formatBytes(state.quant.bytes),
              })}
            </DialogDescription>
          </DialogHeader>
          <DialogFooter>
            <Button
              variant="ghost"
              size="sm"
              onClick={() => setConfirmRemove(false)}
            >
              {t('common:cancel')}
            </Button>
            <Button
              variant="destructive"
              size="sm"
              autoFocus
              data-testid="audio-model-remove-confirm"
              onClick={() => {
                setConfirmRemove(false)
                void state.remove()
              }}
            >
              {t('audios:model.removeConfirm')}
            </Button>
          </DialogFooter>
        </DialogContent>
      </Dialog>
    </div>
  )
}

type AudioModelPickerProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The prompt card's model pill and the list it opens: the mode's catalog models,
 * each with its size, license, notice and Download, whose progress stays in the
 * row. Picking a model on disk closes the list.
 */
export const AudioModelPicker = memo(function AudioModelPicker({
  open,
  onOpenChange,
}: AudioModelPickerProps) {
  const { t } = useTranslation()
  const { mode, model } = useAudioGeneration()
  const catalog = useAudioGenerationStore((state) => state.catalog)
  const core = useAudioGenerationStore((state) => state.core)
  const engineInstalled = useAudioGenerationStore(
    (state) => state.status?.install.state === 'installed'
  )
  const hostBackendId = useAudioGenerationStore((state) => state.hostBackendId)
  const pickModel = useAudioGenerationStore((state) => state.pickModel)
  const models = useMemo(() => audioModelsOf(catalog, mode), [catalog, mode])
  const canDownload =
    core === 'ready' && (engineInstalled || hostBackendId !== null)

  return (
    <div className="flex w-full min-w-0 flex-col gap-1.5">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <MediaModelPickerButton
            aria-label={t('audios:model.select')}
            aria-expanded={open}
            data-testid="audio-models-toggle"
          >
            <AudioLines size={16} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {model?.name ?? t('audios:model.select')}
            </span>
            <IconChevronDown
              size={14}
              className={cn(
                'shrink-0 text-muted-foreground transition-transform',
                open && 'rotate-180'
              )}
            />
          </MediaModelPickerButton>
        </PopoverTrigger>
        <PopoverContent
          align="start"
          sideOffset={6}
          className="max-h-[min(60vh,480px)] w-[400px] max-w-[calc(100vw-2rem)] overflow-y-auto rounded-xl border bg-background/95 p-1.5 shadow-xl backdrop-blur-2xl"
          data-testid="audio-models-list"
        >
          <p className="px-2 py-2 text-xs font-medium text-muted-foreground">
            {t(`audios:model.listTitle_${mode}`)}
          </p>
          {models.map((entry) => (
            <ModelRow
              key={entry.id}
              model={entry}
              selected={entry.id === model?.id}
              canDownload={canDownload}
              onPick={(installed) => {
                pickModel(entry.id)
                if (installed) onOpenChange(false)
              }}
            />
          ))}
          {!canDownload && (
            <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
              {t('audios:model.unavailable')}
            </p>
          )}
        </PopoverContent>
      </Popover>
      <AudioAttribution text={model?.attribution ?? null} className="pl-1" />
    </div>
  )
})
