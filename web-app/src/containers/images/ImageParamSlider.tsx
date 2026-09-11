import { memo, useEffect, useState } from 'react'

import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'

type ImageParamSliderProps = {
  id: string
  label: string
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
 * A slider with a numeric input beside it — the `ContextSizeControl` pattern.
 *
 * The input keeps its own text while focused so the user can clear it and type
 * a new number without the field snapping back to the minimum after the first
 * keystroke; the value is committed on blur and Enter.
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
    <div className="space-y-2">
      <div className="flex items-center justify-between gap-3">
        <label htmlFor={id} className="text-xs font-medium">
          {label}
        </label>
        <Input
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
          className="h-7 w-20 text-right font-mono text-xs tabular-nums"
        />
      </div>
      <Slider
        aria-label={label}
        disabled={disabled}
        value={[clamp(value, min, max)]}
        min={min}
        max={max}
        step={step}
        onValueChange={([next]) => onChange(next)}
      />
      {description && (
        <p className="text-[11px] text-muted-foreground">{description}</p>
      )}
    </div>
  )
})

export default ImageParamSlider
