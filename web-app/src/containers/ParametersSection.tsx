import { useState, type KeyboardEvent } from 'react'
import { Input } from '@/components/ui/input'
import { Slider } from '@/components/ui/slider'
import { Switch } from '@/components/ui/switch'
import {
  paramCategories,
  paramGroups,
  paramsSettings,
  SAMPLING_PARAM_KEYS,
  type ParamSetting,
} from '@/lib/predefinedParams'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'

interface ParametersSectionProps {
  parameters: Record<string, unknown>
  onChange: (key: string, value: number | boolean) => void
  /** Subset/order of param keys to render. Defaults to all sampling keys. */
  paramKeys?: string[]
  className?: string
}

function readNumber(
  parameters: Record<string, unknown>,
  setting: ParamSetting
): number {
  const raw = parameters[setting.key]
  if (typeof raw === 'number' && !Number.isNaN(raw)) return raw
  if (typeof raw === 'string' && raw.trim() !== '' && !Number.isNaN(Number(raw)))
    return Number(raw)
  return setting.value as number
}

function readBoolean(
  parameters: Record<string, unknown>,
  setting: ParamSetting
): boolean {
  const raw = parameters[setting.key]
  if (typeof raw === 'boolean') return raw
  return setting.value as boolean
}

function clamp(value: number, min?: number, max?: number): number {
  let next = value
  if (typeof min === 'number') next = Math.max(min, next)
  if (typeof max === 'number') next = Math.min(max, next)
  return next
}

/** Digits after the point, so a step does not leave 0.30000000000000004. */
function decimals(value: number): number {
  return (String(value).split('.')[1] ?? '').length
}

/**
 * A typed number, read with either decimal separator ("0,7" or "0.7"), or
 * undefined while it is not one yet ("", "-", "."). An unfinished "0." reads
 * as 0, so the value follows the keyboard while the field keeps the point.
 */
function parseDecimal(text: string): number | undefined {
  const normalized = text.trim().replace(',', '.')
  if (!/^[-+]?(?:\d+\.?\d*|\.\d+)$/.test(normalized)) return undefined
  const value = Number(normalized)
  return Number.isFinite(value) ? value : undefined
}

/**
 * The number beside a parameter's name. A text field, not `type="number"`:
 * WKWebView renders a number input with the macOS region's separator, so an
 * English UI on a Russian Mac read "0,7" beside its "0.7" slider. It shows
 * the value with a point, takes a comma or a point, keeps what is being
 * typed until the field is left, and steps with the arrow keys.
 */
function NumberField({
  value,
  min,
  max,
  step,
  label,
  onChange,
}: {
  value: number
  min?: number
  max?: number
  step?: number
  label: string
  onChange: (value: number) => void
}) {
  const [draft, setDraft] = useState<string | null>(null)

  const stepBy = (direction: 1 | -1) => {
    const increment = step ?? 1
    const places = Math.max(decimals(increment), decimals(value))
    const next = Number((value + direction * increment).toFixed(places))
    setDraft(null)
    onChange(clamp(next, min, max))
  }

  const handleKeyDown = (event: KeyboardEvent<HTMLInputElement>) => {
    if (event.key !== 'ArrowUp' && event.key !== 'ArrowDown') return
    event.preventDefault()
    stepBy(event.key === 'ArrowUp' ? 1 : -1)
  }

  return (
    <Input
      type="text"
      inputMode="decimal"
      autoComplete="off"
      spellCheck={false}
      aria-label={label}
      role="spinbutton"
      aria-valuenow={value}
      aria-valuemin={min}
      aria-valuemax={max}
      value={draft ?? String(value)}
      onFocus={() => setDraft(String(value))}
      onBlur={() => setDraft(null)}
      onKeyDown={handleKeyDown}
      onChange={(e) => {
        setDraft(e.target.value)
        const parsed = parseDecimal(e.target.value)
        if (parsed === undefined) return
        onChange(clamp(parsed, min, max))
      }}
      className="h-6 w-14 rounded-md border-0 bg-transparent px-1 py-0 text-right text-xs! leading-6 text-muted-foreground/80 tabular-nums shadow-none focus-visible:ring-0 dark:bg-transparent"
    />
  )
}

export function ParametersSection({
  parameters,
  onChange,
  paramKeys = SAMPLING_PARAM_KEYS,
  className,
}: ParametersSectionProps) {
  const { t } = useTranslation()
  const visible = new Set(paramKeys)

  return (
    <div className={cn('space-y-2.5', className)}>
      {paramCategories.map((category) => {
        const keys = paramGroups[category.id].filter((key) => visible.has(key))
        if (keys.length === 0) return null

        return (
          <div key={category.id} className="space-y-1.5">
            <div className="text-[11px] font-medium text-muted-foreground/70 uppercase tracking-wide">
              {t(`assistants:paramCategory.${category.id}`)}
            </div>

            {keys.map((key) => {
              const setting = paramsSettings[key]
              if (!setting) return null

              if (setting.controllerType === 'checkbox') {
                const checked = readBoolean(parameters, setting)
                return (
                  <div
                    key={key}
                    className="flex items-center justify-between gap-4"
                  >
                    <span
                      className="text-sm text-muted-foreground truncate"
                      title={setting.description}
                    >
                      {setting.title}
                    </span>
                    <Switch
                      checked={checked}
                      onCheckedChange={(value) => onChange(key, value)}
                    />
                  </div>
                )
              }

              const value = readNumber(parameters, setting)
              return (
                <div key={key} className="space-y-1">
                  <div className="flex items-center justify-between gap-3">
                    <span
                      className="text-sm text-muted-foreground truncate"
                      title={setting.description}
                    >
                      {setting.title}
                    </span>
                    <NumberField
                      value={value}
                      min={setting.min}
                      max={setting.max}
                      step={setting.step}
                      label={setting.title}
                      onChange={(next) => onChange(key, next)}
                    />
                  </div>
                  {setting.controllerType === 'slider' && (
                    <Slider
                      value={[value]}
                      min={setting.min ?? 0}
                      max={setting.max ?? 1}
                      step={setting.step ?? 0.01}
                      onValueChange={(values) => onChange(key, values[0])}
                      className="[&_[data-slot=slider-track]]:bg-muted [&_[data-slot=slider-range]]:bg-muted-foreground/40 [&_[data-slot=slider-thumb]]:border-muted-foreground/40 [&_[data-slot=slider-thumb]]:bg-muted-foreground"
                    />
                  )}
                </div>
              )
            })}
          </div>
        )
      })}
    </div>
  )
}
