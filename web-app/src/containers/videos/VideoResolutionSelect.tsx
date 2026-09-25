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

type VideoResolutionSelectProps = {
  width: number
  height: number
  /** The sizes the loaded family was trained at; the menu offers exactly these. */
  presets: readonly [number, number][]
  disabled?: boolean
  onChange: (size: { width: number; height: number }) => void
}

const pillClass =
  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-background px-3.5 text-sm shadow-xs transition-colors focus-within:border-ring dark:bg-input/30 dark:border-input'

/**
 * One pill menu of the family's resolution presets. A video model has a
 * short list of sizes it was trained at, so there is no aspect ratio and
 * no free width and height: the menu is the whole control.
 */
export const VideoResolutionSelect = memo(function VideoResolutionSelect({
  width,
  height,
  presets,
  disabled,
  onChange,
}: VideoResolutionSelectProps) {
  const { t } = useTranslation()
  const label = (w: number, h: number) =>
    `${w} × ${h}${h > w ? t('videos:form.portraitSuffix') : ''}`

  return (
    <ImageField
      label={t('videos:form.resolution')}
      hint={t('videos:form.resolutionHint')}
    >
      <DropdownMenu>
        <DropdownMenuTrigger asChild>
          <button
            type="button"
            disabled={disabled}
            aria-label={t('videos:form.resolution')}
            data-testid="video-resolution"
            className={cn(
              pillClass,
              'cursor-pointer justify-between outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
            )}
          >
            <span className="truncate tabular-nums">{label(width, height)}</span>
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
          {presets.map(([w, h]) => (
            <DropdownMenuItem
              key={`${w}x${h}`}
              data-testid={`video-resolution-${w}x${h}`}
              className={cn(
                'cursor-pointer tabular-nums',
                w === width && h === height && 'bg-secondary-foreground/8'
              )}
              onClick={() => onChange({ width: w, height: h })}
            >
              {label(w, h)}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </ImageField>
  )
})

export default VideoResolutionSelect
