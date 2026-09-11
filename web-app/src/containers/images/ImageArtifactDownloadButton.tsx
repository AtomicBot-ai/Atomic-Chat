import { memo } from 'react'
import { IconCircleCheckFilled, IconDownload, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { formatBytes } from '@/lib/downloadFormat'
import type { ImageArtifactState } from '@/hooks/useImageArtifact'

type ImageArtifactDownloadButtonProps = {
  artifact: ImageArtifactState
  /** Primary in the setup wizard, outline in the selector list. */
  variant?: 'primary' | 'outline'
  /** Called instead of downloading straight away — the selector shows the plan dialog first. */
  onRequestDownload?: () => void
}

/**
 * Download / progress-with-cancel / installed, for one checkpoint. Reads its
 * progress from `useDownloadStore` through `useImageArtifact`, the same way
 * the voice model card does, so the download panel and this button agree.
 */
export const ImageArtifactDownloadButton = memo(
  function ImageArtifactDownloadButton({
    artifact,
    variant = 'outline',
    onRequestDownload,
  }: ImageArtifactDownloadButtonProps) {
    const { t } = useTranslation()
    const percent = Math.round(artifact.progress * 100)

    if (artifact.downloading) {
      return (
        <div className="flex flex-col items-end gap-1">
          <Button
            variant="outline"
            size="sm"
            onClick={() => void artifact.cancelDownload()}
            aria-label={t('common:cancelDownload')}
            className="group relative w-24 justify-center overflow-hidden font-semibold"
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
          <p
            className="text-right text-xs tabular-nums text-muted-foreground"
            aria-live="polite"
          >
            {t('images:model.progress', {
              current: formatBytes(artifact.currentBytes, artifact.downloadTotalBytes),
              total: formatBytes(artifact.downloadTotalBytes, artifact.downloadTotalBytes),
            })}
          </p>
        </div>
      )
    }

    if (artifact.complete) {
      return (
        <span className="flex items-center gap-1.5 text-xs font-medium text-emerald-600 dark:text-emerald-400">
          <IconCircleCheckFilled size={16} />
          {t('images:model.installed')}
        </span>
      )
    }

    return (
      <Button
        variant={variant === 'primary' ? 'default' : 'outline'}
        size="sm"
        onClick={() =>
          onRequestDownload ? onRequestDownload() : void artifact.download()
        }
      >
        <IconDownload size={16} />
        {artifact.installed && !artifact.complete
          ? t('images:model.finishDownload')
          : t('images:model.download')}
      </Button>
    )
  }
)

export default ImageArtifactDownloadButton
