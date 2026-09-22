import { memo, useEffect, useState, type ComponentType } from 'react'
import {
  IconArrowsHorizontal,
  IconArrowsLeftRight,
  IconArrowsVertical,
  IconChevronDown,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import {
  Tooltip,
  TooltipContent,
  TooltipTrigger,
} from '@/components/ui/tooltip'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ASPECT_RATIOS,
  dimOptions,
  formatMegapixels,
  sizeForAspect,
  sizeForEdge,
  sizeOptions,
  snapDim,
  type AspectId,
  type DimConstraints,
} from '@/lib/diffusion/size'
import { cn } from '@/lib/utils'
import { ImageField } from './ImageField'

export type ImageSizeValue = {
  width: number
  height: number
  aspect: AspectId
  portrait: boolean
}

type ImageSizeControlProps = {
  value: ImageSizeValue
  constraints: DimConstraints
  disabled?: boolean
  onChange: (value: ImageSizeValue) => void
}

/** The pill-shaped control the aspect menu and the two size boxes share. */
const pillClass =
  'flex h-9 min-w-0 flex-1 items-center gap-2 rounded-full border border-input bg-background px-3.5 text-sm shadow-xs transition-colors focus-within:border-ring dark:bg-input/30 dark:border-input'

/**
 * Aspect ratio (a menu plus Flip) over Resolution. A preset owns the shape,
 * so Resolution is one menu of the sizes at that ratio — there is no second
 * number that could disagree with it. Custom owns nothing, so Resolution
 * becomes width and height, each typed or picked. Every value leaves here
 * snapped to `dimMultiple` inside the model's range, so the form never holds
 * a size the engine will refuse.
 */
export const ImageSizeControl = memo(function ImageSizeControl({
  value,
  constraints,
  disabled,
  onChange,
}: ImageSizeControlProps) {
  const { t } = useTranslation()
  const longEdge = Math.max(value.width, value.height)
  const custom = value.aspect === 'custom'
  const square = value.aspect === 'square'

  // The ratio reads the way the image is turned: 4:3 in landscape, 3:4 in portrait.
  const aspectLabel = (id: AspectId) => {
    const entry = ASPECT_RATIOS.find((item) => item.id === id)
    if (!entry) return id
    if (!entry.ratioLabel) return t(entry.labelKey)
    const ratio = value.portrait
      ? entry.ratioLabel.split(':').reverse().join(':')
      : entry.ratioLabel
    return `${t(entry.labelKey)} (${ratio})`
  }

  const pickAspect = (aspect: AspectId) => {
    if (aspect === 'custom') {
      onChange({ ...value, aspect })
      return
    }
    const size = sizeForAspect(aspect, value.portrait, longEdge, constraints)
    onChange({ ...size, aspect, portrait: value.portrait })
  }

  // Only Custom types edges, so the pair is free and the orientation follows it.
  const setEdge = (edge: 'width' | 'height', next: number) => {
    const size = sizeForEdge(
      value.aspect,
      value.portrait,
      edge,
      next,
      constraints,
      value
    )
    onChange({ ...value, ...size, portrait: size.height > size.width })
  }

  const flip = () => {
    onChange({
      width: value.height,
      height: value.width,
      aspect: value.aspect,
      portrait: !value.portrait,
    })
  }

  return (
    <div className="flex flex-col gap-4" data-testid="image-size-control">
      <ImageField
        label={t('images:size.aspectRatio')}
        hint={t('images:size.aspectHint')}
      >
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <button
                type="button"
                disabled={disabled}
                aria-label={t('images:size.aspectRatio')}
                className={cn(
                  pillClass,
                  'cursor-pointer justify-between outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
                )}
              >
                <span className="truncate">{aspectLabel(value.aspect)}</span>
                <IconChevronDown
                  size={16}
                  className="shrink-0 text-muted-foreground"
                />
              </button>
            </DropdownMenuTrigger>
            <DropdownMenuContent
              align="start"
              className="w-(--radix-dropdown-menu-trigger-width) min-w-48"
            >
              {ASPECT_RATIOS.map((entry) => (
                <DropdownMenuItem
                  key={entry.id}
                  className={cn(
                    'cursor-pointer',
                    entry.id === value.aspect && 'bg-secondary-foreground/8'
                  )}
                  onClick={() => pickAspect(entry.id)}
                >
                  {aspectLabel(entry.id)}
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          <Tooltip>
            <TooltipTrigger asChild>
              <span className="inline-flex shrink-0">
                <Button
                  type="button"
                  variant="secondary"
                  size="icon"
                  disabled={disabled || square}
                  aria-label={t('images:size.flip')}
                  aria-pressed={value.portrait}
                  className={cn((disabled || square) && 'pointer-events-none')}
                  onClick={flip}
                >
                  {/* The arrows turn with the orientation, showing which way it flips. */}
                  <IconArrowsLeftRight
                    size={16}
                    className={cn(
                      'transition-transform duration-200',
                      value.portrait && 'rotate-90'
                    )}
                  />
                </Button>
              </span>
            </TooltipTrigger>
            <TooltipContent>
              {square
                ? t('images:size.squareNoFlip')
                : value.portrait
                  ? t('images:size.toLandscape')
                  : t('images:size.toPortrait')}
            </TooltipContent>
          </Tooltip>
        </div>
      </ImageField>

      <ImageField
        label={t('images:size.resolution')}
        hint={
          custom
            ? t('images:size.resolutionHint')
            : t('images:size.resolutionPresetHint')
        }
        trailing={
          // The typed boxes already show the pixels; only the megapixels are news.
          custom && (
            <span className="text-[11px] tabular-nums text-muted-foreground">
              {t('images:size.megapixels', {
                mp: formatMegapixels(value.width, value.height),
              })}
            </span>
          )
        }
      >
        {custom ? (
          <div className="flex items-center gap-2">
            <DimensionSelect
              id="image-width"
              icon={IconArrowsHorizontal}
              label={t('images:size.width')}
              value={value.width}
              options={dimOptions(constraints)}
              constraints={constraints}
              disabled={disabled}
              onChange={(width) => setEdge('width', width)}
            />
            <DimensionSelect
              id="image-height"
              icon={IconArrowsVertical}
              label={t('images:size.height')}
              value={value.height}
              options={dimOptions(constraints)}
              constraints={constraints}
              disabled={disabled}
              onChange={(height) => setEdge('height', height)}
            />
          </div>
        ) : (
          // A row, like the aspect menu above: the pill's `flex-1` sizes width, not height.
          <div className="flex items-center">
            <PresetSizeSelect
              value={value}
              constraints={constraints}
              disabled={disabled}
              onChange={(size) => onChange({ ...value, ...size })}
            />
          </div>
        )}
      </ImageField>
    </div>
  )
})

type PresetSizeSelectProps = {
  value: ImageSizeValue
  constraints: DimConstraints
  disabled?: boolean
  onChange: (size: { width: number; height: number }) => void
}

/** One menu of the sizes a locked ratio allows, each with its megapixels. */
function PresetSizeSelect({
  value,
  constraints,
  disabled,
  onChange,
}: PresetSizeSelectProps) {
  const { t } = useTranslation()
  const options = sizeOptions(value.aspect, value.portrait, constraints)
  const megapixels = (width: number, height: number) =>
    t('images:size.megapixels', { mp: formatMegapixels(width, height) })

  return (
    <DropdownMenu>
      <DropdownMenuTrigger asChild>
        <button
          type="button"
          disabled={disabled}
          aria-label={t('images:size.resolution')}
          data-testid="image-size-preset"
          className={cn(
            pillClass,
            'cursor-pointer justify-between outline-none focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50 disabled:cursor-not-allowed disabled:opacity-50'
          )}
        >
          <span className="truncate tabular-nums">
            {value.width} × {value.height}
          </span>
          <span className="ml-auto shrink-0 text-xs tabular-nums text-muted-foreground">
            {megapixels(value.width, value.height)}
          </span>
          <IconChevronDown
            size={16}
            className="shrink-0 text-muted-foreground"
          />
        </button>
      </DropdownMenuTrigger>
      <DropdownMenuContent
        align="start"
        className="max-h-72 w-(--radix-dropdown-menu-trigger-width) min-w-48 overflow-y-auto"
      >
        {options.map((size) => (
          <DropdownMenuItem
            key={`${size.width}x${size.height}`}
            className={cn(
              'cursor-pointer justify-between tabular-nums',
              size.width === value.width &&
                size.height === value.height &&
                'bg-secondary-foreground/8'
            )}
            onClick={() => onChange(size)}
          >
            <span>
              {size.width} × {size.height}
            </span>
            <span className="text-xs text-muted-foreground">
              {megapixels(size.width, size.height)}
            </span>
          </DropdownMenuItem>
        ))}
      </DropdownMenuContent>
    </DropdownMenu>
  )
}

type DimensionSelectProps = {
  id: string
  icon: ComponentType<{ size?: number; className?: string }>
  label: string
  value: number
  options: number[]
  constraints: DimConstraints
  disabled?: boolean
  onChange: (value: number) => void
}

/**
 * One edge: type a number, or pick one of the usual sizes from the menu.
 * Typing is held in a draft so a half-entered value is not snapped
 * mid-keystroke; it commits on blur and Enter.
 */
function DimensionSelect({
  id,
  icon: Icon,
  label,
  value,
  options,
  constraints,
  disabled,
  onChange,
}: DimensionSelectProps) {
  const { t } = useTranslation()
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])

  const commit = () => {
    const parsed = Number(text)
    const next = snapDim(
      Number.isFinite(parsed) && parsed > 0 ? parsed : value,
      constraints
    )
    setText(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <div className={cn(pillClass, disabled && 'opacity-50')}>
      <Icon size={16} className="shrink-0 text-muted-foreground" />
      <input
        id={id}
        aria-label={label}
        type="number"
        inputMode="numeric"
        min={constraints.minDim}
        max={constraints.maxDim}
        step={constraints.dimMultiple}
        disabled={disabled}
        value={text}
        onChange={(event) => setText(event.target.value.replace(/[^\d]/g, ''))}
        onBlur={commit}
        onKeyDown={(event) => {
          if (event.key === 'Enter') {
            event.preventDefault()
            commit()
          }
        }}
        className="w-full min-w-0 bg-transparent tabular-nums outline-none disabled:cursor-not-allowed [appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none"
      />
      <DropdownMenu>
        <DropdownMenuTrigger
          disabled={disabled}
          aria-label={t('images:size.presets', { label })}
          className="-mr-1.5 shrink-0 cursor-pointer rounded-full p-1 text-muted-foreground transition-colors outline-none hover:text-foreground focus-visible:ring-2 focus-visible:ring-ring disabled:cursor-not-allowed"
        >
          <IconChevronDown size={16} />
        </DropdownMenuTrigger>
        <DropdownMenuContent
          align="end"
          className="max-h-72 w-28 overflow-y-auto"
        >
          {options.map((edge) => (
            <DropdownMenuItem
              key={edge}
              className={cn(
                'cursor-pointer tabular-nums',
                edge === value && 'bg-secondary-foreground/8'
              )}
              onClick={() => onChange(edge)}
            >
              {edge}
            </DropdownMenuItem>
          ))}
        </DropdownMenuContent>
      </DropdownMenu>
    </div>
  )
}

export default ImageSizeControl
