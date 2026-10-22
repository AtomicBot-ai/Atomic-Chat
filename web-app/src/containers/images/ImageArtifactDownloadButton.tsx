import { memo } from 'react'
import { IconPlayerPlay, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageArtifactState } from '@/hooks/useImageArtifact'
import { cn } from '@/lib/utils'

type ImageArtifactDownloadButtonProps = {
  artifact: ImageArtifactState
  /** Visual hierarchy chosen by the setup or compact selector row. */
  variant?: 'primary' | 'outline'
  className?: string
  /** Called instead of downloading straight away — the selector shows the plan dialog first. */
  onRequestDownload?: () => void
}

/**
 * Download / progress-with-cancel / Resume for one checkpoint; nothing once complete. Reads its
 * progress from `useDownloadStore` through `useImageArtifact`, the same way
 * the voice model card does, so the download panel and this button agree.
 */
export const ImageArtifactDownloadButton = memo(
  function ImageArtifactDownloadButton({
    artifact,
    variant = 'outline',
    className,
    onRequestDownload,
  }: ImageArtifactDownloadButtonProps) {
    const { t } = useTranslation()
    const percent = Math.round(artifact.progress * 100)

    // A paused download — also one a quit cut off, brought back after the
    // relaunch — offers Resume rather than Cancel or a fresh Download: the
    // transfer picks up from the bytes on disk (QA 2.2.23, AC-10). Same box as
    // the running pill, with the panel's play mark in front of the percent.
    if (artifact.paused) {
      const label = t('common:resumeDownload')
      return (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void artifact.resume()}
          aria-label={label}
          title={label}
          className={cn(
            'relative w-24 justify-center gap-1 overflow-hidden font-semibold',
            className
          )}
        >
          <span
            aria-hidden
            className="absolute inset-y-0 left-0 z-0 bg-primary/20"
            style={{ width: `${percent}%` }}
          />
          <IconPlayerPlay size={14} className="relative z-10" aria-hidden />
          <span className="relative z-10 tabular-nums">{percent}%</span>
        </Button>
      )
    }

    // One button-sized box in every state: the byte count lives in the row's
    // size line, so starting a download does not make the row taller.
    if (artifact.downloading) {
      return (
        <Button
          variant="outline"
          size="sm"
          onClick={() => void artifact.cancelDownload()}
          aria-label={t('common:cancelDownload')}
          className={cn(
            'group relative w-24 justify-center overflow-hidden font-semibold',
            className
          )}
        >
          <span
            className="absolute inset-y-0 left-0 z-0 bg-primary/20 transition-[width] duration-200"
            style={{ width: `${percent}%` }}
          />
          <span className="relative z-10 tabular-nums group-hover:hidden">
            {percent}%
          </span>
          <IconX size={14} className="relative z-10 hidden group-hover:block" />
        </Button>
      )
    }

    // Complete: nothing to fetch, and the row's Run/Stop already says it is on disk.
    if (artifact.complete) return null

    return (
      <Button
        variant={variant === 'primary' ? 'default' : 'outline'}
        size="sm"
        className={className}
        onClick={() =>
          onRequestDownload ? onRequestDownload() : void artifact.download()
        }
      >
        {artifact.installed && !artifact.complete
          ? t('images:model.finishDownload')
          : t('images:model.download')}
      </Button>
    )
  }
)

export default ImageArtifactDownloadButton
