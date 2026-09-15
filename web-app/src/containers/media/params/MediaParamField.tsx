/**
 * One `MediaParamSpec`, rendered.
 *
 * This is the fix for coupling C5. `MediaGenerationForm.tsx` hand-writes about
 * 180 lines of controls, one per knob, which is why adding a parameter today
 * means editing a file frozen by the protected-surface guard. A renderer that
 * walks the schema replaces all of it, and a provider can then announce a knob
 * this build has never heard of and still get a usable form.
 *
 * Two constraints shape it:
 *
 *  - **It must look identical to what ships today.** `fieldClass` and
 *    `labelClass` are copied verbatim from `MediaGenerationForm.tsx:11-14`.
 *  - **It must keep the identities the app already has.** The well-known
 *    parameters keep their exact `id` and `aria-label`, because existing suites
 *    assert on them and changing them would be an accessibility regression.
 */

import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { MediaParamSpec } from '@/services/media/contract'
import { ImageFileInput } from './ImageFileInput'
import {
  CHOICE_PARAM_TYPES,
  NUMERIC_PARAM_TYPES,
  fieldClass,
  isRenderableParam,
  labelClass,
  mediaParamDomId,
  mediaParamLabel,
} from './paramIdentity'

export type MediaParamFieldProps = {
  spec: MediaParamSpec
  value: unknown
  disabled?: boolean
  onChange: (id: string, value: unknown) => void
  onBlur: (id: string) => void
}

export function MediaParamField({
  spec,
  value,
  disabled,
  onChange,
  onBlur,
}: MediaParamFieldProps) {
  const { t } = useTranslation()
  const domId = mediaParamDomId(spec)
  const ariaLabel = mediaParamLabel(spec)

  // Task 14 Step 5. A provider may supply `label_key` / `help_key` instead of
  // raw text, so its parameters can be translated like the rest of the app.
  // The provider's own untranslated `label` / `help` is the defaultValue, so a
  // provider that ships a key we have no translation for still renders its own
  // words rather than a raw key - and one that ships no key at all is
  // unaffected.
  const label = spec.label_key
    ? t(spec.label_key, { defaultValue: spec.label ?? ariaLabel })
    : (spec.label ?? ariaLabel)
  const help = spec.help_key
    ? t(spec.help_key, { defaultValue: spec.help ?? '' })
    : spec.help

  const known = isRenderableParam(spec)

  const shared = {
    id: domId,
    'aria-label': ariaLabel,
    disabled: disabled || !known,
    onBlur: () => onBlur(spec.id),
  }

  return (
    <div>
      <label className={labelClass} htmlFor={domId}>
        {label}
        {spec.required ? <span aria-hidden="true"> *</span> : null}
      </label>

      {/* A type from a newer contract must degrade to something inert and
          explained, never take the surrounding form down. */}
      {!known ? (
        <>
          <input {...shared} className={fieldClass} type="text" readOnly value="" />
          <p className="mt-1 text-xs text-muted-foreground">
            This parameter is not supported by this version of Radium.
          </p>
        </>
      ) : spec.type === 'image_ref' && spec.accept?.length ? (
        // Only a parameter that lists the files it accepts takes the picture
        // itself; a v1 worker's `input_image` is a path and keeps its text box.
        <ImageFileInput
          id={domId}
          label={label}
          value={value}
          accept={spec.accept}
          disabled={disabled}
          onChange={(next) => onChange(spec.id, next)}
        />
      ) : spec.type === 'text' ? (
        <textarea
          {...shared}
          className={cn(fieldClass, 'h-auto min-h-20 py-2')}
          placeholder={spec.placeholder_key}
          value={typeof value === 'string' ? value : ''}
          onChange={(event) => onChange(spec.id, event.target.value)}
        />
      ) : spec.type === 'bool' ? (
        <input
          {...shared}
          className="size-4 rounded border-border/70"
          type="checkbox"
          checked={value === true}
          onChange={(event) => onChange(spec.id, event.target.checked)}
        />
      ) : CHOICE_PARAM_TYPES.has(spec.type) ? (
        <select
          {...shared}
          className={fieldClass}
          value={value === undefined || value === null ? '' : String(value)}
          onChange={(event) => onChange(spec.id, event.target.value)}
        >
          {(spec.options ?? []).map((option) => (
            <option key={String(option.value)} value={String(option.value)}>
              {option.label ?? String(option.value)}
            </option>
          ))}
        </select>
      ) : NUMERIC_PARAM_TYPES.has(spec.type) ? (
        <input
          {...shared}
          className={fieldClass}
          type="number"
          min={spec.min}
          max={spec.max}
          step={spec.step}
          value={typeof value === 'number' ? value : ''}
          onChange={(event) =>
            // Empty stays empty rather than becoming 0. For a seed that is the
            // difference between "randomise" and "always use zero".
            onChange(
              spec.id,
              event.target.value === '' ? undefined : Number(event.target.value)
            )
          }
        />
      ) : (
        <input
          {...shared}
          className={fieldClass}
          type="text"
          placeholder={spec.placeholder_key}
          value={
            Array.isArray(value)
              ? value.join(', ')
              : typeof value === 'string'
                ? value
                : ''
          }
          onChange={(event) =>
            onChange(
              spec.id,
              spec.type === 'stringlist'
                ? event.target.value
                    .split(',')
                    .map((entry) => entry.trim())
                    .filter(Boolean)
                : event.target.value
            )
          }
        />
      )}

      {help && known ? (
        <p className="mt-1 text-xs text-muted-foreground">{help}</p>
      ) : null}
    </div>
  )
}
