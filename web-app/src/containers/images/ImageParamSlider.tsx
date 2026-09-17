import { memo, useEffect, useState } from 'react'

import { Slider } from '@/components/ui/slider'
import { cn } from '@/lib/utils'
import { ImageFieldHint } from './ImageField'

type ImageParamSliderProps = {
  id: string
  label: string
  /** What the knob does, behind an (i) beside the label. */
  description?: string
  value: number
  min: number
  max: number
  step: number
  disabled?: boolean
  onChange: (value: number) => void
}

const clamp = (value: number, lo: number, hi: number) =>
  Math.min(Math.max(value, lo), hi)

/**
 * One row: label, track, value — the shape every slider on the page has, so
 * the column reads as a table of settings rather than a stack of cards.
 *
 * The value is an input, not a readout: it keeps its own text while focused
 * so the user can clear it and type a new number without the field snapping
 * back to the minimum after the first keystroke; the value is committed on
 * blur and Enter.
 */
export const ImageParamSlider = memo(function ImageParamSlider({
  id,
  label,
  description,
  value,
  min,
  max,
  step,
  disabled,
  onChange,
}: ImageParamSliderProps) {
  const [text, setText] = useState(String(value))

  useEffect(() => {
    setText(String(value))
  }, [value])

  const commit = () => {
    const parsed = Number(text)
    if (!Number.isFinite(parsed)) {
      setText(String(value))
      return
    }
    const snapped = Math.round(parsed / step) * step
    const next = clamp(Number(snapped.toFixed(4)), min, max)
    setText(String(next))
    if (next !== value) onChange(next)
  }

  return (
    <div className="flex items-center gap-3">
      <div className="flex w-32 shrink-0 items-center gap-1">
        <label htmlFor={id} className="truncate text-xs font-medium">
          {label}
        </label>
        {description && <ImageFieldHint>{description}</ImageFieldHint>}
      </div>
      <Slider
        aria-label={label}
        disabled={disabled}
        value={[clamp(value, min, max)]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
        className="min-w-0 flex-1"
      />
      <input
        id={id}
        type="number"
        inputMode="decimal"
        min={min}
        max={max}
        step={step}
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
        className={cn(
          'h-7 w-14 shrink-0 rounded-md border border-transparent bg-transparent px-1.5 text-right text-sm tabular-nums outline-none transition-colors',
          'hover:border-input focus-visible:border-ring focus-visible:ring-[3px] focus-visible:ring-ring/50',
          'disabled:cursor-not-allowed disabled:opacity-50',
          '[appearance:textfield] [&::-webkit-inner-spin-button]:appearance-none [&::-webkit-outer-spin-button]:appearance-none'
        )}
      />
    </div>
  )
})

export default ImageParamSlider
