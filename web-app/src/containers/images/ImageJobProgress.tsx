import { memo } from 'react'

import { Progress } from '@/components/ui/progress'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageJob } from '@/services/diffusion/types'

type ImageJobProgressProps = {
  job: ImageJob | null
  runsTotal: number
  runsDone: number
  /** The user pressed Stop and the plugin is winding the renderer down. */
  stopping: boolean
}

/**
 * `Step 12/28 · ~14 s · image 2 of 4 · run 1 of 3` over a bar.
 *
 * `aria-live="polite"` so a screen reader hears the step count change without
 * the user having to hunt for it — this is the only thing that moves on the
 * page during a generation.
 *
 * The bar fills from the plugin's overall estimate, which spans the whole job:
 * encoding, all images of the batch, decoding. A queued job with no step
 * lines yet shows the phase name rather than `0/0`.
 */
export const ImageJobProgress = memo(function ImageJobProgress({
  job,
  runsTotal,
  runsDone,
  stopping,
}: ImageJobProgressProps) {
  const { t } = useTranslation()
  if (!job) return null

  const progress = job.progress
  const percent = Math.round((progress?.fraction ?? 0) * 100)
  const parts: string[] = []

  if (stopping) {
    parts.push(t('images:progress.stopping'))
  } else if (progress && progress.totalSteps > 0) {
    parts.push(
      t('images:progress.step', {
        step: progress.step,
        total: progress.totalSteps,
      })
    )
    if (progress.etaSeconds !== null && progress.etaSeconds > 0) {
      parts.push(
        t('images:progress.eta', { seconds: Math.round(progress.etaSeconds) })
      )
    }
  } else {
    parts.push(t(`images:progress.phase.${progress?.phase ?? job.state}`))
  }

  if (progress && progress.batchSize > 1) {
    parts.push(
      t('images:progress.image', {
        index: progress.batchIndex + 1,
        total: progress.batchSize,
      })
    )
  }
  if (runsTotal > 1) {
    parts.push(
      t('images:progress.run', {
        run: Math.min(runsDone + 1, runsTotal),
        total: runsTotal,
      })
    )
  }

  return (
    <div className="space-y-1.5" data-testid="image-job-progress">
      <Progress
        aria-label={t('images:progress.label')}
        value={percent}
        className="h-1.5 bg-muted"
        indicatorClassName={stopping ? 'bg-muted-foreground' : undefined}
      />
      <p
        className="text-xs tabular-nums text-muted-foreground"
        aria-live="polite"
      >
        {parts.join(' · ')}
      </p>
    </div>
  )
})

export default ImageJobProgress
