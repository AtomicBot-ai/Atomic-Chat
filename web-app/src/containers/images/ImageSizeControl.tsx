import { memo, useEffect, useState } from 'react'
import { ChevronsUpDown } from 'lucide-react'
import { IconArrowsExchange } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  DropdownMenu,
  DropdownMenuContent,
  DropdownMenuItem,
  DropdownMenuTrigger,
} from '@/components/ui/dropdown-menu'
import { Input } from '@/components/ui/input'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  ASPECT_RATIOS,
  dimOptions,
  formatMegapixels,
  sizeForAspect,
  snapDim,
  type AspectId,
  type DimConstraints,
} from '@/lib/diffusion/size'
import { cn } from '@/lib/utils'

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

/**
 * Aspect presets + a long-edge picker + flip, with free-form width/height
 * under Custom. Every value leaves here snapped to `dimMultiple` inside the
 * model's range, so the form never holds a size the engine will refuse.
 */
export const ImageSizeControl = memo(function ImageSizeControl({
  value,
  constraints,
  disabled,
  onChange,
}: ImageSizeControlProps) {
  const { t } = useTranslation()
  const longEdge = Math.max(value.width, value.height)
  const options = dimOptions(constraints)
  const custom = value.aspect === 'custom'

  const pickAspect = (aspect: AspectId) => {
    if (aspect === 'custom') {
      onChange({ ...value, aspect })
      return
    }
    const size = sizeForAspect(aspect, value.portrait, longEdge, constraints)
    onChange({ ...size, aspect, portrait: value.portrait })
  }

  const pickLongEdge = (edge: number) => {
    const size = sizeForAspect(
      value.aspect,
      value.portrait,
      edge,
      constraints,
      value
    )
    onChange({ ...value, ...size })
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
    <div className="space-y-2" data-testid="image-size-control">
      <div className="flex items-center justify-between gap-3">
        <span className="text-xs font-medium">{t('images:size.title')}</span>
        <span className="font-mono text-xs tabular-nums text-muted-foreground">
          {value.width}×{value.height} ·{' '}
          {t('images:size.megapixels', {
            mp: formatMegapixels(value.width, value.height),
          })}
        </span>
      </div>
      <div className="flex flex-wrap gap-1">
        {ASPECT_RATIOS.map((preset) => (
          <Button
            key={preset.id}
            type="button"
            size="xs"
            variant={value.aspect === preset.id ? 'default' : 'outline'}
            disabled={disabled}
            aria-pressed={value.aspect === preset.id}
            onClick={() => pickAspect(preset.id)}
          >
            {t(preset.labelKey)}
          </Button>
        ))}
      </div>
      {custom ? (
        <div className="flex items-center gap-2">
          <DimInput
            id="image-width"
            label={t('images:size.width')}
            value={value.width}
            constraints={constraints}
            disabled={disabled}
            onCommit={(width) =>
              onChange({
                ...value,
                width,
                aspect: 'custom',
                portrait: value.height > width,
              })
            }
          />
          <span className="text-muted-foreground">×</span>
          <DimInput
            id="image-height"
            label={t('images:size.height')}
            value={value.height}
            constraints={constraints}
            disabled={disabled}
            onCommit={(height) =>
              onChange({
                ...value,
                height,
                aspect: 'custom',
                portrait: height > value.width,
              })
            }
          />
        </div>
      ) : (
        <div className="flex items-center gap-2">
          <DropdownMenu>
            <DropdownMenuTrigger asChild>
              <Button
                type="button"
                variant="outline"
                size="sm"
                disabled={disabled}
                className="w-36 justify-between font-mono text-xs"
                aria-label={t('images:size.longEdge')}
              >
                {longEdge}px
                <ChevronsUpDown className="ml-2 size-4 shrink-0 text-muted-foreground" />
              </Button>
            </DropdownMenuTrigger>
            <DropdownMenuContent align="start" className="max-h-64 w-36 overflow-y-auto">
              {options.map((edge) => (
                <DropdownMenuItem
                  key={edge}
                  className={cn(
                    'cursor-pointer font-mono text-xs',
                    edge === longEdge && 'bg-secondary-foreground/8'
                  )}
                  onClick={() => pickLongEdge(edge)}
                >
                  {edge}px
                </DropdownMenuItem>
              ))}
            </DropdownMenuContent>
          </DropdownMenu>
          {value.aspect !== 'square' && (
            <Button
              type="button"
              variant="ghost"
              size="sm"
              disabled={disabled}
              onClick={flip}
              aria-pressed={value.portrait}
            >
              <IconArrowsExchange size={16} />
              {value.portrait
                ? t('images:size.portrait')
                : t('images:size.landscape')}
            </Button>
          )}
        </div>
      )}
    </div>
  )
})

type DimInputProps = {
  id: string
  label: string
  value: number
  constraints: DimConstraints
  disabled?: boolean
  onCommit: (value: number) => void
}

/** Free-form dimension; snaps on blur/Enter so typing is not fought. */
function DimInput({
  id,
  label,
  value,
  constraints,
  disabled,
  onCommit,
}: DimInputProps) {
  const [text, setText] = useState(String(value))
  useEffect(() => setText(String(value)), [value])

  const commit = () => {
    const parsed = Number(text)
    const next = snapDim(Number.isFinite(parsed) ? parsed : value, constraints)
    setText(String(next))
    if (next !== value) onCommit(next)
  }

  return (
    <Input
      id={id}
      aria-label={label}
      type="number"
      inputMode="numeric"
      min={constraints.minDim}
      max={constraints.maxDim}
      step={constraints.dimMultiple}
      disabled={disabled}
      value={text}
      onChange={(event) => setText(event.target.value)}
      onBlur={commit}
      onKeyDown={(event) => {
        if (event.key === 'Enter') {
          event.preventDefault()
          commit()
        }
      }}
      className="h-8 w-24 font-mono text-xs tabular-nums"
    />
  )
}

export default ImageSizeControl
