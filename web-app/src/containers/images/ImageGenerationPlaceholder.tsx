import { memo, useEffect, useState, type CSSProperties } from 'react'

import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageJobProgress } from '@/services/diffusion/types'
import { cn } from '@/lib/utils'
import { mediaPreviewFrameStyle } from './mediaPreview'
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
  /**
   * Viewer only: the whole job's 0–1 fraction, drawn as a bar inside the frame
   * under the status. Omitted, there is no bar (an image job has no fraction).
   */
  fraction?: number | null
  /** Viewer only: the time left, worded, added to the step and elapsed line. */
  remaining?: string | null
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
    fraction = null,
    remaining = null,
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

    // The viewer's geometry: the frame is the picture's or clip's frame-to-be
    // (same width, same height cap), and the bottom padding holds the
    // toolbar row the result will bring, so the gallery under the preview
    // does not move when the result replaces it.
    return (
      <div
        className="flex min-w-0 justify-center px-6 pt-4 pb-[calc(var(--control-height,1.75rem)+1rem)] [container-type:inline-size]"
        data-testid="image-generation-preview"
        role="status"
        aria-live="polite"
        aria-atomic="true"
      >
        <div
          className="relative shrink-0 overflow-hidden rounded-xl border border-border/70 bg-secondary/25 shadow-sm"
          style={mediaPreviewFrameStyle(width, height)}
        >
          <span
            className="sr-only"
            data-testid="image-generation-progress-announcement"
          >
            {announcement}
          </span>
          {/* Everything about the job sits in the frame: the status, the bar
              and one line of step, elapsed and time left. The words are the
              announcement's, so only the bar stays in the accessibility tree. */}
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4 [container-type:size]">
            <DottedGenerationField />
            <div className="flex w-full flex-col items-center gap-0.5 px-3 text-center">
              <p
                className="max-w-full truncate text-xs font-medium text-foreground/80"
                aria-hidden="true"
              >
                {copy.status}
              </p>
              {fraction !== null && (
                <Progress
                  aria-label={t('images:progress.label')}
                  value={Math.round(fraction * 100)}
                  className="my-1.5 h-1 w-[min(12rem,55cqw)] bg-muted"
                  data-testid="image-generation-progress-bar"
                />
              )}
              <p
                className="max-w-full truncate text-[11px] tabular-nums text-muted-foreground/80"
                aria-hidden="true"
                data-testid="image-generation-progress-detail"
              >
                {copy.detail ? `${copy.detail} · ${elapsed}` : elapsed}
                {remaining && (
                  <span data-testid="image-generation-remaining">
                    {` · ${remaining}`}
                  </span>
                )}
              </p>
            </div>
          </div>
        </div>
      </div>
    )
  }
)

export default ImageGenerationPlaceholder
