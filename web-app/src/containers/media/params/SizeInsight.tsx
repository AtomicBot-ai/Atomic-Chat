/**
 * The resolution picker's details, under "Show advanced": the size that will
 * actually render (a custom size snapped to the model's multiple), warnings
 * when it is outside the model's comfortable range, a rough memory estimate,
 * and the finished size after upscaling.
 *
 * Rules and preset estimates come from the engine's catalog on the
 * resolution spec (`size_rules`, option `vram_mb`); see
 * `services/media/resolution.ts`.
 */

import type { MediaParamSpec } from '@/services/media/contract'
import {
  checkSize,
  estimateVramMb,
  formatGb,
  framesFor,
  outputTarget,
} from '@/services/media/resolution'

type Props = {
  specs: MediaParamSpec[]
  values: Record<string, unknown>
}

export function SizeInsight({ specs, values }: Props) {
  const spec = specs.find((s) => s.type === 'resolution' && s.size_rules)
  const rules = spec?.size_rules
  if (!spec || !rules) return null

  const chosen = String(values[spec.id] ?? spec.default ?? '')
  const option = spec.options?.find((o) => String(o.value) === chosen)
  const isCustom = chosen === 'custom'

  const seconds = Number(values.length_seconds)
  const fps = Number(values.fps)
  const frames =
    Number.isFinite(seconds) && seconds > 0 && Number.isFinite(fps) && fps > 0
      ? framesFor(seconds, fps)
      : undefined

  let width = option?.width ?? rules.native[0]
  let height = option?.height ?? rules.native[1]
  let warnings: string[] = []
  if (isCustom) {
    const check = checkSize(
      rules,
      Number(values.custom_width ?? rules.native[0]),
      Number(values.custom_height ?? rules.native[1])
    )
    width = check.width
    height = check.height
    warnings = check.warnings
  }
  const vram =
    !isCustom && frames === undefined && typeof option?.vram_mb === 'number'
      ? option.vram_mb
      : estimateVramMb(rules, rules.base_memory_mb ?? 0, width, height, frames)

  const outputSpec = specs.find((s) => s.id === 'output_size')
  const outputOption = outputSpec?.options?.find(
    (o) => String(o.value) === String(values.output_size ?? outputSpec?.default)
  )
  const longEdge = outputOption?.long_edge ?? 0
  const [finalW, finalH] = outputTarget(width, height, longEdge)

  return (
    <div
      data-testid="media-size-insight"
      className="rounded-md border border-border/60 bg-muted/30 p-3 text-xs leading-5"
    >
      <p>
        Renders at <strong>{width} × {height}</strong>
        {frames !== undefined ? ` · ${frames} frames` : ''}
        {longEdge > 0 ? (
          <>
            , upscaled to <strong>{finalW} × {finalH}</strong>
          </>
        ) : null}
        .
      </p>
      <p className="text-muted-foreground">
        Rough graphics memory: about {formatGb(vram)} (native {rules.native[0]} ×{' '}
        {rules.native[1]}, sides in multiples of {rules.multiple}).
      </p>
      {warnings.map((warning) => (
        <p key={warning} role="status" className="text-amber-600 dark:text-amber-400">
          {warning}
        </p>
      ))}
    </div>
  )
}
