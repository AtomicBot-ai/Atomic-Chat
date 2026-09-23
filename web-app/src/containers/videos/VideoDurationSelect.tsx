import { memo } from 'react'
import { IconChevronDown } from '@tabler/icons-react'

import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { ImageField } from '@/containers/images/ImageField'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { formatSeconds, type DurationOption } from '@/lib/video/duration'

type VideoDurationSelectProps = {
  frames: number
  options: readonly DurationOption[]
  disabled?: boolean
  onChange: (frames: number) => void
}

const pillClass =
  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-background px-3.5 text-sm shadow-xs transition-colors focus-within:border-ring dark:bg-input/30 dark:border-input'

/**
 * The clip length as a pill menu: seconds first, the frame count the model
 * actually renders beside it. The options come from the family's frame
 * lattice, so every one is a count the engine accepts as is.
 */
export const VideoDurationSelect = memo(function VideoDurationSelect({
  frames,
  options,
  disabled,
  onChange,
}: VideoDurationSelectProps) {
  const { t } = useTranslation()
  const label = (option: DurationOption) =>
    t('videos:form.durationOption', {
      seconds: formatSeconds(option.seconds),
      frames: option.frames,
    })
  const current =
    options.find((option) => option.frames === frames) ??
    options[0] ?? { frames, seconds: 0 }

  return (
    <ImageField
      label={t('videos:form.duration')}
      hint={t('videos:form.durationHint')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('videos:form.duration')}
            data-testid="video-duration"
            className={cn(
              pillClass,
              'cursor-pointer justify-between outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            <span className="truncate tabular-nums">{label(current)}</span>
            <IconChevronDown
              size={16}
              className="ml-auto shrink-0 text-muted-foreground"
            />
          </button>
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="start"
          className="max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-48 overflow-y-auto"
        >
          {options.map((option) => (
            <DropdownMenuItem
              key={option.frames}
              data-testid={`video-duration-${option.frames}`}
              className={cn(
                'cursor-pointer tabular-nums',
                option.frames === frames && 'bg-secondary-foreground/8'
              )}
              onClick={() => onChange(option.frames)}
            >
              {label(option)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ImageField>
  )
})

export default VideoDurationSelect
