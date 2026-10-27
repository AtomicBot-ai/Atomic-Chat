import { memo } from 'react'
import { IconCheck, IconChevronDown, IconDownload } from '@tabler/icons-react'
import { AudioLines } from 'lucide-react'

import { Button } from '@/components/ui/button'
import {
  Popover,
  PopoverContent,
  PopoverTrigger,
} from '@/components/ui/popover'
import { MediaModelPickerButton } from '@/containers/images/MediaStudio'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { AUDIO_MODELS, type AudioMode } from '@/lib/audio/models'
import { cn } from '@/lib/utils'

type AudioModelPickerProps = {
  mode: AudioMode
  value: string
  onChange: (model: string) => void
  open: boolean
  onOpenChange: (open: boolean) => void
}

/**
 * The prompt card's model pill and the list it opens: the mode's models,
 * each with its Download. With no audio engine yet a download cannot start,
 * so the buttons stay off and the list says when they will work.
 */
export const AudioModelPicker = memo(function AudioModelPicker({
  mode,
  value,
  onChange,
  open,
  onOpenChange,
}: AudioModelPickerProps) {
  const { t } = useTranslation()
  const models = AUDIO_MODELS[mode]
  const selected = models.find((model) => model.id === value)

  return (
    <div className="flex w-full min-w-0 items-center gap-1.5">
      <Popover open={open} onOpenChange={onOpenChange}>
        <PopoverTrigger asChild>
          <MediaModelPickerButton
            aria-label={t('audios:model.select')}
            aria-expanded={open}
            data-testid="audio-models-toggle"
          >
            <AudioLines size={16} className="shrink-0 text-muted-foreground" />
            <span className="min-w-0 flex-1 truncate text-left font-medium">
              {selected?.name ?? t('audios:model.select')}
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
          {models.map((model) => (
            <div
              key={model.id}
              className="my-1 flex items-center gap-2 rounded-xl border p-3"
            >
              <button
                type="button"
                className="flex min-w-0 flex-1 items-center gap-3 text-left"
                aria-pressed={model.id === value}
                onClick={() => onChange(model.id)}
              >
                <AudioLines
                  size={24}
                  className="shrink-0 text-muted-foreground"
                />
                <span className="min-w-0 flex-1">
                  <strong className="block truncate text-sm font-medium">
                    {model.name}
                  </strong>
                  <span className="text-xs text-muted-foreground">
                    {t(`audios:mode.${mode}.title`)}
                  </span>
                </span>
                {model.id === value && <IconCheck size={16} />}
              </button>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled
                aria-label={t('audios:model.download', { name: model.name })}
              >
                <IconDownload size={14} />
                {t('audios:model.downloadShort')}
              </Button>
            </div>
          ))}
          <p className="px-2 pt-1 pb-1.5 text-xs text-muted-foreground">
            {t('audios:model.comingSoon')}
          </p>
        </PopoverContent>
      </Popover>
    </div>
  )
})
