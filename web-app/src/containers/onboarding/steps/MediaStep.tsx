import { ArrowRight, Check, Download, ImageIcon, Video } from 'lucide-react'

import { FamilyLogoMark } from '@/containers/ModelLogo'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { diffusionDownloadTaskId } from '@/lib/diffusion/models'
import { captureOnboardingEvent } from '@/lib/onboarding-telemetry'
import type { OnboardingJob } from '@/lib/onboarding/jobs'
import { cn } from '@/lib/utils'
import { useOnboardingStore } from '@/stores/onboarding-store'

import { useMediaCards, type MediaCard } from './mediaAvailability'
import type { StepProps } from './types'
import '../media.css'

const GB = 1024 ** 3

/** What a card's button says about its family's place in the queue. */
const QUEUE_LABEL: Record<Exclude<OnboardingJob['phase'], 'done'>, string> = {
  queued: 'onboarding-media:queue.queued',
  running: 'onboarding-media:queue.downloading',
  failed: 'onboarding-media:queue.interrupted',
}

/**
 * "Go beyond text": an image and a video model this machine can run, each
 * added to or taken off the run's download queue. They download one at a
 * time after the chat model (`OnboardingRuntime` starts them through
 * `startMediaJob`); taking a card off while it downloads stops its transfer.
 */
export function MediaStep({ next }: StepProps) {
  const { t } = useTranslation()
  const cards = useMediaCards()
  const jobs = useOnboardingStore((state) => state.jobs)
  // The chat model's download is not this step's choice: only media counts.
  const mediaQueued = jobs.some((job) => job.kind !== 'chat')

  const toggle = (card: MediaCard, job: OnboardingJob | undefined) => {
    const store = useOnboardingStore.getState()
    if (job) {
      store.dequeue(card.family)
    } else {
      store.enqueue({
        key: card.family,
        kind: card.modality,
        title: card.title,
        taskId: diffusionDownloadTaskId(card.artifactId),
        artifactId: card.artifactId,
        totalBytes: card.downloadBytes,
        phase: 'queued',
      })
    }
    captureOnboardingEvent('onboarding_media_queued', {
      media_family: card.family,
      queue_action: job ? 'removed' : 'added',
    })
  }

  // A media job shows its own family's name here even while it points at the
  // engine install (`lib/onboarding/media-jobs`).
  const order =
    mediaQueued && jobs.length > 1
      ? jobs
          .map(
            (job) =>
              cards.find((card) => card.family === job.key)?.title ?? job.title
          )
          .join(' → ')
      : null

  return (
    <>
      <h1 tabIndex={-1}>{t('onboarding-media:title')}</h1>
      <p className="ob-lead">{t('onboarding-media:lead')}</p>
      <div className="ob-media-grid">
        {cards.map((card) => {
          const job = jobs.find((candidate) => candidate.key === card.family)
          const downloaded = card.downloaded || job?.phase === 'done'
          const titleId = `ob-media-${card.family}`
          const Icon = card.modality === 'video' ? Video : ImageIcon
          return (
            <article
              key={card.family}
              className={cn(job && 'is-queued')}
              aria-labelledby={titleId}
            >
              <div
                className={cn(
                  'ob-media-art',
                  card.modality === 'video' && 'is-video'
                )}
                aria-hidden="true"
              >
                <Icon size={36} />
                <span>{t(`onboarding-media:art.${card.modality}`)}</span>
              </div>
              <div className="ob-media-title">
                {card.logoSrc && (
                  <span className="ob-media-logo" aria-hidden="true">
                    <FamilyLogoMark src={card.logoSrc} />
                  </span>
                )}
                <h2 id={titleId}>{card.title}</h2>
              </div>
              <p>{t(`onboarding-media:purpose.${card.modality}`)}</p>
              <small>
                {[
                  t(
                    downloaded
                      ? 'onboarding-media:size.onDisk'
                      : 'onboarding-media:size.download',
                    { size: (card.downloadBytes / GB).toFixed(1) }
                  ),
                  t('onboarding-media:memory', {
                    size: Math.ceil(card.memoryBytes / GB),
                  }),
                ].join(' · ')}
              </small>
              {card.fit === 'maybe' && (
                <small className="ob-caution">
                  {t('onboarding-media:caution')}
                </small>
              )}
              {downloaded ? (
                <span className="ob-media-done">
                  <Check size={16} aria-hidden="true" />
                  {t('onboarding-media:queue.downloaded')}
                </span>
              ) : (
                <button
                  type="button"
                  className="ob-secondary"
                  aria-pressed={Boolean(job)}
                  aria-describedby={titleId}
                  onClick={() => toggle(card, job)}
                >
                  {job ? (
                    <Check size={16} aria-hidden="true" />
                  ) : (
                    <Download size={16} aria-hidden="true" />
                  )}
                  {job && job.phase !== 'done'
                    ? t(QUEUE_LABEL[job.phase])
                    : t('onboarding-media:queue.add')}
                </button>
              )}
            </article>
          )
        })}
      </div>
      {order && (
        <p className="ob-note">{t('onboarding-media:order', { order })}</p>
      )}
      <div className="ob-actions">
        <button
          type="button"
          className="ob-primary"
          onClick={() => next(mediaQueued ? 'continue' : 'skip')}
        >
          {mediaQueued ? t('onboarding:continue') : t('onboarding-media:skip')}
          <ArrowRight size={17} aria-hidden="true" />
        </button>
      </div>
    </>
  )
}
