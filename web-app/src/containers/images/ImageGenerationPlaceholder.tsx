import { memo, useEffect, useState } from 'react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageJobProgress } from '@/services/diffusion/types'
import { cn } from '@/lib/utils'

type ImageGenerationPlaceholderProps = {
  variant: 'viewer' | 'tile'
  width: number
  height: number
  progress: ImageJobProgress | null
  startedAtMs: number
  index?: number
}

function GenerationPulse({ compact = false }: { compact?: boolean }) {
  return (
    <div
      className={cn(
        'relative shrink-0 text-primary',
        compact ? 'size-10' : 'size-20'
      )}
      aria-hidden
    >
      <span className="absolute inset-0 rounded-full border-2 border-dotted border-current opacity-25 motion-safe:animate-[spin_8s_linear_infinite]" />
      <span className="absolute inset-[18%] rounded-full border-2 border-dotted border-current opacity-45 motion-safe:animate-[spin_5s_linear_infinite_reverse]" />
      <span className="absolute inset-[38%] rounded-full bg-current opacity-60 motion-safe:animate-pulse" />
      <span className="absolute inset-[46%] rounded-full bg-background" />
    </div>
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

    if (variant === 'tile') {
      return (
        <div
          className="relative aspect-square overflow-hidden rounded-lg border border-border/70 bg-secondary/35"
          data-testid={`image-generation-tile-${index}`}
          aria-label={t('images:progress.generatingImage')}
        >
          <div className="absolute inset-0 bg-primary/[0.06] motion-safe:animate-pulse" />
          <div className="absolute inset-0 flex items-center justify-center">
            <GenerationPulse compact />
          </div>
          <span className="absolute inset-x-2 bottom-2 truncate text-center text-[10px] text-muted-foreground">
            {step}
          </span>
        </div>
      )
    }

    return (
      <div
        className="flex size-full min-h-48 items-center justify-center px-6 py-4"
        data-testid="image-generation-preview"
        aria-live="polite"
      >
        <div className="relative grid max-h-full max-w-full overflow-hidden rounded-xl border border-border/70 bg-secondary/25 shadow-sm">
          <svg
            width={Math.max(width, 1)}
            height={Math.max(height, 1)}
            viewBox={`0 0 ${Math.max(width, 1)} ${Math.max(height, 1)}`}
            className="col-start-1 row-start-1 max-h-full max-w-full"
            aria-hidden
          />
          <div className="absolute inset-0 bg-primary/[0.06] motion-safe:animate-pulse" />
          <div className="absolute inset-0 flex flex-col items-center justify-center gap-4">
            <GenerationPulse />
            <div className="space-y-1 text-center">
              <p className="text-sm font-medium">
                {t('images:progress.generatingImage')}
              </p>
              <p className="text-xs tabular-nums text-muted-foreground">
                {step} ·{' '}
                {t('images:progress.elapsed', { seconds: elapsedSeconds })}
              </p>
            </div>
          </div>
          <div className="absolute inset-x-0 bottom-0 h-1 bg-muted" aria-hidden>
            <div
              className="h-full bg-primary transition-[width] duration-500 ease-out"
              style={{
                width: `${Math.max(2, Math.round((progress?.fraction ?? 0) * 100))}%`,
              }}
            />
          </div>
        </div>
      </div>
    )
  }
)

export default ImageGenerationPlaceholder
