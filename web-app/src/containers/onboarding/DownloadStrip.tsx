import { Check, Download, Pause, Play } from 'lucide-react'

import { useDownloadStore } from '@/hooks/useDownloadStore'
import { useModelProvider } from '@/hooks/useModelProvider'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { isPausableDownload, pauseDownload } from '@/lib/downloadControls'
import { formatDownloadReadout } from '@/lib/downloadFormat'
import { resumeDownload } from '@/lib/downloadResume'
import { cn } from '@/lib/utils'
import { findChatModel, jobView } from '@/lib/onboarding/jobs'
import { useOnboardingStore } from '@/stores/onboarding-store'

/**
 * The run's downloads, one line: the job in flight with its progress and
 * Pause/Resume, how many wait behind it, or the chat model ready once it is.
 * Shown above every step after Welcome, and in the panel after the handoff.
 */
export function DownloadStrip() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const jobs = useOnboardingStore((state) => state.jobs)
  const choice = useOnboardingStore((state) => state.choice)
  const downloads = useDownloadStore((state) => state.downloads)
  const pausedDownloads = useDownloadStore((state) => state.pausedDownloads)
  const providers = useModelProvider((state) => state.providers)

  const active = jobs.find((job) => job.phase !== 'done')
  const ready = findChatModel(choice, providers)
  if (!active && !ready) return null

  if (!active) {
    return (
      <section
        className="ob-download"
        aria-label={t('onboarding:download.label')}
      >
        <div className="ob-download-row">
          <span className="ob-download-icon">
            <Check size={18} aria-hidden="true" />
          </span>
          <div>
            <strong>
              {t('onboarding:download.ready', { name: choice?.title ?? '' })}
            </strong>
            <span>{t('onboarding:download.onDevice')}</span>
          </div>
        </div>
      </section>
    )
  }

  const view = jobView(active, { downloads, pausedDownloads })
  const download = downloads[active.taskId]
  const queued = jobs.filter((job) => job.phase === 'queued').length
  const readout =
    view.state === 'queued'
      ? t('onboarding:download.queued')
      : view.state === 'interrupted'
        ? t('onboarding:download.interrupted')
        : formatDownloadReadout(t, {
            progress: download?.progress ?? 0,
            current: view.currentBytes,
            total: view.totalBytes,
            bytesPerSecond: download?.speed?.bytesPerSecond ?? 0,
            stage: download?.stage,
            paused: view.state === 'paused',
          })
  const target = { id: active.taskId, name: download?.name ?? active.taskId }
  const canPause =
    isPausableDownload(active.taskId) &&
    (view.state === 'downloading' || view.state === 'preparing')

  return (
    <section
      className={cn('ob-download', view.state === 'interrupted' && 'has-error')}
      aria-label={t('onboarding:download.label')}
    >
      <div className="ob-download-row">
        <span className="ob-download-icon">
          <Download size={18} aria-hidden="true" />
        </span>
        <div>
          <strong>{active.title}</strong>
          <span>
            {queued > 0
              ? t('onboarding:download.withQueued', { readout, count: queued })
              : readout}
          </span>
        </div>
        <b>{view.percent}%</b>
        {canPause && (
          <button
            type="button"
            className="ob-icon"
            aria-label={t('onboarding:download.pause')}
            onClick={() => pauseDownload(target, serviceHub)}
          >
            <Pause size={16} aria-hidden="true" />
          </button>
        )}
        {view.state === 'paused' && (
          <button
            type="button"
            className="ob-icon"
            aria-label={t('onboarding:download.resume')}
            onClick={() => resumeDownload(target, { serviceHub, t })}
          >
            <Play size={16} aria-hidden="true" />
          </button>
        )}
      </div>
      <div
        className="ob-progress"
        role="progressbar"
        aria-label={t('onboarding:download.progress', { name: active.title })}
        aria-valuenow={view.percent}
        aria-valuemin={0}
        aria-valuemax={100}
      >
        <i style={{ width: `${view.percent}%` }} />
      </div>
    </section>
  )
}
