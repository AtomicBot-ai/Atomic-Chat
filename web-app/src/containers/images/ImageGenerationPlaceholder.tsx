import { memo, useEffect, useState, type CSSProperties } from 'react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageJobProgress } from '@/services/diffusion/types'
import { cn } from '@/lib/utils'
import './ImageGenerationPlaceholder.css'

/** What the placeholder reads of a job's progress; an image and a video job both carry it. */
export type PlaceholderProgress = Pick<
  ImageJobProgress,
  'phase' | 'step' | 'totalSteps' | 'elapsedMs'
>

type ImageGenerationPlaceholderProps = {
  variant: 'viewer' | 'tile'
  width: number
  height: number
  progress: PlaceholderProgress | null
  startedAtMs: number
  index?: number
  /** Which words the status uses: an image is "generated", a clip is "encoded". */
  kind?: 'image' | 'video'
}

type Translation = ReturnType<typeof useTranslation>['t']

type ProgressCopy = {
  status: string
  detail: string | null
}

/** The keys of one kind's progress copy; the image keys are the ones the page always had. */
const COPY_KEYS = {
  image: {
    generating: 'images:progress.generatingImage',
    finalizing: 'images:progress.finalizingImage',
    step: 'images:progress.step',
    elapsed: 'images:progress.elapsed',
    phase: 'images:progress.phase',
  },
  video: {
    generating: 'videos:progress.generatingVideo',
    finalizing: 'videos:progress.finalizingVideo',
    step: 'videos:progress.step',
    elapsed: 'videos:progress.elapsed',
    phase: 'videos:progress.phase',
  },
} as const

/**
 * Sampling owns the numeric step label only while there are steps left. Once
 * sampling is complete, the renderer's phase is more truthful than `20/20`:
 * VAE decode, post-processing and the gallery write can all take noticeable
 * time. Older/ambiguous progress falls back to an honest finalizing state.
 */
function progressCopy(
  progress: PlaceholderProgress | null,
  t: Translation,
  kind: 'image' | 'video' = 'image'
): ProgressCopy {
  const keys = COPY_KEYS[kind]
  const phase = progress?.phase ?? 'queued'
  const hasSteps = Boolean(progress && progress.totalSteps > 0)
  const samplingComplete = Boolean(
    progress && hasSteps && progress.step >= progress.totalSteps
  )

  if (phase === 'decoding') {
    return { status: t(`${keys.phase}.decoding`), detail: null }
  }
  if (phase === 'postprocessing') {
    return { status: t(`${keys.phase}.postprocessing`), detail: null }
  }
  if (phase === 'saving') {
    return { status: t(`${keys.phase}.saving`), detail: null }
  }
  if (samplingComplete) {
    return { status: t(keys.finalizing), detail: null }
  }
  if (phase === 'sampling' && progress && hasSteps) {
    return {
      status: t(keys.generating),
      detail: t(keys.step, {
        step: progress.step,
        total: progress.totalSteps,
      }),
    }
  }

  return {
    status: t(keys.generating),
    detail: t(`${keys.phase}.${phase}`),
  }
}

const DOT_GRID_SIZE = 19
const DOT_FIELD_RADIUS = 46
const DOT_WAVE_SECONDS = 2.8

const DOTS = Array.from(
  { length: DOT_GRID_SIZE * DOT_GRID_SIZE },
  (_, index) => {
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
    // A broad falloff fades the perimeter even at the crest of the wave,
    // avoiding a bright, sharply cut circular edge as the field rotates.
    const falloff = Math.exp(-Math.pow(radius / 0.72, 4))
    const restOpacity = (0.24 + (1 - radius) * 0.12) * falloff
    const ringStrength = Math.exp(-Math.pow((radius - 0.48) / 0.4, 2))
    const staticOpacity = (0.28 + ringStrength * 0.3) * falloff

    return {
      x,
      y,
      style: {
        '--dot-delay': `${-(phase * DOT_WAVE_SECONDS).toFixed(3)}s`,
        '--dot-rest-opacity': restOpacity.toFixed(3),
        '--dot-peak-opacity': (0.82 * falloff).toFixed(3),
        '--dot-blur': `${(radius * radius * 0.45).toFixed(3)}px`,
        '--dot-low-opacity': (restOpacity * 0.42).toFixed(3),
        '--dot-fall-opacity': (restOpacity * 0.78).toFixed(3),
        '--dot-static-opacity': staticOpacity.toFixed(3),
      } as CSSProperties,
    }
  }
).filter((dot): dot is NonNullable<typeof dot> => dot !== null)

function DottedGenerationField({ compact = false }: { compact?: boolean }) {
  return (
    <svg
      viewBox="0 0 100 100"
      className={cn(
        'generation-dotted-field shrink-0 text-foreground/70',
        compact
          ? 'generation-dotted-field--tile'
          : 'generation-dotted-field--viewer'
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
    kind = 'image',
  }: ImageGenerationPlaceholderProps) {
    const { t } = useTranslation()
    const [now, setNow] = useState(Date.now())

    useEffect(() => {
      if (variant === 'tile') return
      const timer = window.setInterval(() => setNow(Date.now()), 1000)
      return () => window.clearInterval(timer)
    }, [variant])

    // sd.cpp owns `progress.elapsedMs`, but that clock does not advance until
    // the renderer starts emitting progress. Keep one UI clock anchored at
    // submission so model preparation / prompt encoding cannot sit at 0 s.
    // Once backend progress arrives, take the furthest clock rather than
    // swapping sources: phase changes must never reset elapsed time.
    const wallElapsedMs = startedAtMs > 0 ? Math.max(0, now - startedAtMs) : 0
    const elapsedSeconds = Math.max(
      0,
      Math.floor(Math.max(progress?.elapsedMs ?? 0, wallElapsedMs) / 1000)
    )
    const copy = progressCopy(progress, t, kind)
    const elapsed = t(COPY_KEYS[kind].elapsed, { seconds: elapsedSeconds })
    const announcement = copy.detail
      ? `${copy.status}. ${copy.detail}.`
      : copy.status

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
            {announcement}
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
            {announcement}
          </span>
          <div
            className="absolute inset-0 flex flex-col items-center justify-center gap-4 [container-type:size]"
            aria-hidden="true"
          >
            <DottedGenerationField />
            <div className="space-y-0.5 text-center">
              <p className="text-xs font-medium text-foreground/80">
                {copy.status}
              </p>
              <p className="text-[11px] tabular-nums text-muted-foreground/80">
                {copy.detail ? `${copy.detail} · ${elapsed}` : elapsed}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }
)

export default ImageGenerationPlaceholder
