import { memo } from 'react'
import { useNavigate } from '@tanstack/react-router'
import {
  IconCloud,
  IconDownload,
  IconLoader2,
  IconRefresh,
} from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { ClapperboardIcon } from '@/components/animated-icon/clapperboard'
import { ImageIcon } from '@/components/animated-icon/image'
import { route } from '@/constants/routes'
import { useImageEngine } from '@/hooks/useImageEngine'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatProgressPair } from '@/lib/downloadFormat'
import {
  engineFetchFailureText,
  hostCheckHeadlineKey,
} from '@/lib/engine-fetch-failure'
import { cn } from '@/lib/utils'
import type { DiffusionModality } from '@/services/diffusion/types'
import { useMediaCatalog } from '@/stores/media-catalog-store'

type ImageSetupCardProps = {
  className?: string
  /** The page the card stands on: the words and the mark are that page's own. */
  modality?: DiffusionModality
}

/**
 * What the page shows until the engine binary is installed — the one thing
 * the studio cannot open without. One click installs it, with the progress on
 * the button itself (the downloads panel shows it too); once it lands the page
 * opens the studio, whose empty canvas offers the model download.
 */
export const ImageSetupCard = memo(function ImageSetupCard({
  className,
  modality = 'image',
}: ImageSetupCardProps) {
  const { t } = useTranslation()
  const navigate = useNavigate()
  const engine = useImageEngine()
  // A core that serves remote media offers the other way in: a provider's models, no engine.
  const remoteMedia = useMediaCatalog((state) => state.available)
  const ns = modality === 'video' ? 'videos' : 'images'
  const Icon = modality === 'video' ? ClapperboardIcon : ImageIcon
  const unsupported =
    engine.hostBackendId === null && !engine.resolvingHostBackend
  // A failed check is not a "no build" answer: say what failed, why, how many
  // times it was tried, and offer Retry.
  const checkFailed = unsupported ? engine.hostBackendCheckFailed : null
  const failureReason = checkFailed
    ? [
        engineFetchFailureText(engine.hostBackendReason, t),
        t('images:setup.engine.attempts', { count: engine.hostBackendAttempt }),
      ]
        .filter(Boolean)
        .join(' ')
    : null
  const { transferred, total, error } = engine.progress
  const percent = total > 0 ? Math.round((transferred / total) * 100) : 0
  const busy = engine.installing
    ? `${percent}%`
    : engine.resolvingHostBackend
      ? engine.hostBackendAttempt > 1
        ? t('images:setup.engine.retrying', {
            attempt: engine.hostBackendAttempt,
            total: engine.hostBackendAttempts,
          })
        : t('images:setup.engine.checking')
      : null
  const installReason = error
    ? (engineFetchFailureText(
        [error.message, error.details].filter(Boolean).join(' '),
        t
      ) ?? error.message)
    : ''

  return (
    <div
      className={cn('w-full max-w-2xl space-y-7 px-6 py-8', className)}
      data-testid="image-setup-card"
      data-modality={modality}
    >
      <div className="flex flex-col items-center text-center">
        <div className="mb-5 grid size-16 place-items-center rounded-2xl border bg-secondary/60 shadow-sm">
          <Icon size={32} aria-hidden />
        </div>
        <h1 className="font-studio text-3xl font-semibold tracking-tight">
          {t(`${ns}:setup.card.title`)}
        </h1>
        <p className="mt-2 max-w-lg text-pretty text-sm leading-relaxed text-muted-foreground">
          {unsupported
            ? t(hostCheckHeadlineKey(checkFailed))
            : t(`${ns}:setup.card.description`)}
        </p>
        {failureReason && (
          <p
            className="mt-2 max-w-lg text-pretty text-sm leading-relaxed text-foreground"
            data-testid="image-engine-failure-reason"
          >
            {failureReason}
          </p>
        )}
        {unsupported && engine.hostBackendReason && (
          <p
            className={cn(
              'mt-1 max-w-lg text-pretty break-words text-xs leading-relaxed text-muted-foreground',
              // The core's own words, for a bug report: selectable, set apart.
              checkFailed && 'select-text font-mono text-[11px]'
            )}
            data-testid="image-engine-host-reason"
          >
            {engine.hostBackendReason}
          </p>
        )}
      </div>
      {checkFailed && (
        <div className="flex justify-center">
          <Button
            variant="secondary"
            onClick={() => void engine.retryHostBackend()}
            data-testid="image-engine-retry"
          >
            <IconRefresh size={16} aria-hidden />
            {t('images:errors.actions.retry')}
          </Button>
        </div>
      )}
      {!unsupported && (
        <div className="flex flex-col items-center gap-2 text-center">
          <Button
            size="lg"
            // While installing the fill is the progress, so the button keeps
            // full strength instead of the dimmed disabled look.
            className={cn(
              'relative flex min-w-56 overflow-hidden tabular-nums',
              engine.installing && 'disabled:opacity-100'
            )}
            disabled={busy !== null}
            onClick={() => void engine.startInstall()}
            data-testid="image-engine-install"
          >
            {engine.installing && (
              <span
                aria-hidden
                className="absolute inset-y-0 left-0 bg-primary-foreground/15 transition-[width] duration-200"
                style={{ width: `${percent}%` }}
              />
            )}
            {/* The idle label stays laid out underneath, so the button keeps
                its width when the percentage takes its place. */}
            <span className="relative grid place-items-center">
              <span
                className={cn(
                  'col-start-1 row-start-1 flex items-center gap-2',
                  busy !== null && 'invisible'
                )}
              >
                <IconDownload size={17} aria-hidden />
                {t(`${ns}:setup.card.engine`)}
              </span>
              {busy !== null && (
                <span className="col-start-1 row-start-1 flex items-center gap-2">
                  <IconLoader2 size={17} className="animate-spin" aria-hidden />
                  {busy}
                </span>
              )}
            </span>
          </Button>
          {/* One reserved slot for the byte count or the failure, so neither
              moves the centered card when it appears. */}
          <div className="h-8 w-full max-w-lg" aria-live="polite">
            {engine.installing && total > 0 ? (
              <p
                className="truncate text-xs tabular-nums text-muted-foreground"
                data-testid="image-engine-progress"
              >
                {formatProgressPair(transferred, total)}
              </p>
            ) : error && !engine.installing ? (
              <p
                className="line-clamp-2 text-pretty text-xs text-destructive"
                // The plain reason is shown; the core's own words stay on hover.
                title={
                  installReason !== error.message ? error.message : undefined
                }
                data-testid="image-engine-install-error"
              >
                {t('images:setup.engine.failed')}
                {installReason ? ` ${installReason}` : ''}
              </p>
            ) : null}
          </div>
        </div>
      )}
      {remoteMedia && (
        <div className="flex justify-center">
          <Button
            variant="link"
            size="sm"
            className="text-muted-foreground"
            onClick={() => void navigate({ to: route.cloud.index })}
            data-testid="image-setup-cloud"
          >
            <IconCloud size={16} aria-hidden />
            {t('images:remote.connectProvider')}
          </Button>
        </div>
      )}
    </div>
  )
})

export default ImageSetupCard
