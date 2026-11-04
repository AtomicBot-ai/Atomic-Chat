import { memo, useEffect, useState } from 'react'
import { IconWaveSine } from '@tabler/icons-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { useAudioGenerationStore } from '@/stores/audio-generation-store'

/** Whole seconds since `startedAtMs`, ticking while it is set. */
function useElapsedSeconds(startedAtMs: number | null): number {
  const [now, setNow] = useState(() => Date.now())
  useEffect(() => {
    if (startedAtMs === null) return
    setNow(Date.now())
    const timer = setInterval(() => setNow(Date.now()), 1000)
    return () => clearInterval(timer)
  }, [startedAtMs])
  if (startedAtMs === null) return 0
  return Math.max(0, Math.floor((now - startedAtMs) / 1000))
}

/**
 * What a job is doing. audio.cpp reports no progress, so this names the phase
 * and counts the seconds spent, over a bar that moves and never fills: nothing
 * here may read as a percentage. `pane` is the results pane's centered state.
 */
export const AudioJobStatus = memo(function AudioJobStatus({
  variant = 'inline',
}: {
  variant?: 'inline' | 'pane'
}) {
  const { t } = useTranslation()
  const job = useAudioGenerationStore((state) => state.currentJob)
  const loading = useAudioGenerationStore(
    (state) => state.loadingModelId !== null
  )
  const generating = useAudioGenerationStore((state) => state.generating)
  const stopping = useAudioGenerationStore((state) => state.stopRequested)
  const seconds = useElapsedSeconds(
    job ? (job.startedAtMs ?? job.createdAtMs) : null
  )

  if (!loading && !generating) return null
  const label = stopping
    ? t('audios:progress.stopping')
    : loading
      ? t('audios:progress.modelLoading')
      : t(`audios:progress.phase.${job?.progress?.phase ?? 'queued'}`)
  const text =
    job && !stopping
      ? `${label} · ${t('audios:progress.elapsed', { seconds })}`
      : label

  return (
    <div
      className={cn(
        'flex w-full flex-col gap-1.5',
        variant === 'pane' && 'h-full items-center justify-center gap-4 px-6'
      )}
      data-testid={`audio-job-status-${variant}`}
    >
      {variant === 'pane' && (
        <IconWaveSine size={32} className="text-muted-foreground" />
      )}
      <div
        role="progressbar"
        aria-label={t('audios:progress.label')}
        className={cn(
          'audio-phase-bar',
          stopping && 'is-stopping',
          variant === 'pane' && 'max-w-xs'
        )}
      >
        <i />
      </div>
      <p
        className={cn(
          'text-center tabular-nums text-muted-foreground',
          variant === 'pane' ? 'text-sm' : 'truncate text-[11px] leading-3'
        )}
        aria-live="polite"
      >
        {text}
      </p>
    </div>
  )
})
