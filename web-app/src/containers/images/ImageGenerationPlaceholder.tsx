import { memo, useEffect, useState, type CSSProperties } from 'react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageJobProgress } from '@/services/diffusion/types'
import { cn } from '@/lib/utils'
import './ImageGenerationPlaceholder.css'

type ImageGenerationPlaceholderProps = {
  variant: 'viewer' | 'tile'
  width: number
  height: number
  progress: ImageJobProgress | null
  startedAtMs: number
  index?: number
}

const DOT_GRID_SIZE = 15
const DOT_FIELD_RADIUS = 44
const DOT_WAVE_SECONDS = 2.8

const DOTS = Array.from({ length: DOT_GRID_SIZE * DOT_GRID_SIZE }, (_, index) => {
  const column = index % DOT_GRID_SIZE
  const row = Math.floor(index / DOT_GRID_SIZE)
  const spacing = (DOT_FIELD_RADIUS * 2) / (DOT_GRID_SIZE - 1)
  const x = 50 - DOT_FIELD_RADIUS + column * spacing
  const y = 50 - DOT_FIELD_RADIUS + row * spacing
  const dx = x - 50
  const dy = y - 50
  const distance = Math.hypot(dx, dy)

  if (distance > DOT_FIELD_RADIUS) return null

  const radius = distance / DOT_FIELD_RADIUS
  const angle = (Math.atan2(dy, dx) + Math.PI * 2) % (Math.PI * 2)
  const angleTurn = angle / (Math.PI * 2)
  const phase = (radius * 1.35 + angleTurn * 0.26) % 1
  const restOpacity = 0.22 + (1 - radius) * 0.2
  const ringStrength = Math.exp(-Math.pow((radius - 0.7) / 0.24, 2))
  const staticOpacity = 0.18 + ringStrength * 0.48 + (1 - radius) * 0.08

  return {
    x,
    y,
    style: {
      '--dot-delay': `${-(phase * DOT_WAVE_SECONDS).toFixed(3)}s`,
      '--dot-rest-opacity': restOpacity.toFixed(3),
      '--dot-low-opacity': (restOpacity * 0.42).toFixed(3),
      '--dot-fall-opacity': (restOpacity * 0.78).toFixed(3),
      '--dot-static-opacity': staticOpacity.toFixed(3),
    } as CSSProperties,
  }
}).filter((dot): dot is NonNullable<typeof dot> => dot !== null)

function DottedGenerationField({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn(
        'generation-dotted-field shrink-0 text-foreground/70',
        compact ? 'size-14' : 'size-28'
      )}
      data-testid="generation-dotted-field"
      data-reduced-motion-fallback="static"
      aria-hidden="true"
      focusable="false"
    >
      {DOTS.map((dot, index) => (
        <circle
          key={index}
          className="generation-dot"
          cx={dot.x}
          cy={dot.y}
          r="1.05"
          fill="currentColor"
          style={dot.style}
        />
      ))}
    </svg>
  )
}

/**
 * A virtual result slot shown from submit until the renderer returns an image.
 * It never enters the persisted gallery; completion swaps it for the real
 * gallery item, and failure removes it while the page shows the error banner.
 */
export const ImageGenerationPlaceholder = memo(
  function ImageGenerationPlaceholder({
    variant,
    width,
    height,
    progress,
    startedAtMs,
    index = 0,
  }: ImageGenerationPlaceholderProps) {
    const { t } = useTranslation()
    const [now, setNow] = useState(Date.now())

    useEffect(() => {
      if (variant === 'tile') return
      const timer = window.setInterval(() => setNow(Date.now()), 1000)
      return () => window.clearInterval(timer)
    }, [variant])

    const elapsedSeconds = Math.max(
      0,
      Math.round((progress?.elapsedMs ?? Math.max(0, now - startedAtMs)) / 1000)
    )
    const step = progress?.totalSteps
      ? t('images:progress.step', {
          step: progress.step,
          total: progress.totalSteps,
        })
      : t(`images:progress.phase.${progress?.phase ?? 'queued'}`)
    const elapsed = t('images:progress.elapsed', { seconds: elapsedSeconds })
    const generatingImage = t('images:progress.generatingImage')

    if (variant === 'tile') {
      return (
        <div
          className="relative aspect-square overflow-hidden rounded-lg border border-border/70 bg-secondary/35"
          data-testid={`image-generation-tile-${index}`}
          role="status"
          aria-live="polite"
          aria-atomic="true"
        >
          <div className="absolute inset-0 flex items-center justify-center">
            <DottedGenerationField compact />
          </div>
          <span
            className="sr-only"
            data-testid="image-generation-progress-announcement"
          >
            {generatingImage}. {step}.
          </span>
          <span
            className="absolute inset-x-2 bottom-2 truncate text-center text-[10px] text-muted-foreground/80"
            aria-hidden="true"
          >
            {step}
          </span>
        </div>
      )
    }

    return (
      <div
        className="flex size-full min-h-48 items-center justify-center px-6 py-4"
        data-testid="image-generation-preview"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div className="relative grid max-h-full max-w-full overflow-hidden rounded-xl border border-border/70 bg-secondary/25 shadow-sm">
          <svg
            width={Math.max(width, 1)}
            height={Math.max(height, 1)}
            viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
            className="col-start-1 row-start-1 max-h-full max-w-full"
            aria-hidden
          />
          <span
            className="sr-only"
            data-testid="image-generation-progress-announcement"
          >
            {generatingImage}. {step}.
          </span>
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4"
            aria-hidden="true"
          >
            <DottedGenerationField />
            <div className="space-y-0.5 text-center">
              <p className="text-xs font-medium text-foreground/80">
                {generatingImage}
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground/80">
                {step} · {elapsed}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }
)

export default ImageGenerationPlaceholder
