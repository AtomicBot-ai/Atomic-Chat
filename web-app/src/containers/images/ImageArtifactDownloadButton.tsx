import { memo } from 'react'
import { IconDownload, IconX } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { ImageArtifactState } from '@/hooks/useImageArtifact'

type ImageArtifactDownloadButtonProps = {
  artifact: ImageArtifactState
  /** Primary in the setup wizard, outline in the selector list. */
  variant?: 'primary' | 'outline'
  /** Called instead of downloading straight away — the selector shows the plan dialog first. */
  onRequestDownload?: () => void
}

/**
 * Download / progress-with-cancel for one checkpoint; nothing once complete. Reads its
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

    // One button-sized box in every state: the byte count lives in the row's
    // size line, so starting a download does not make the row taller.
    if (artifact.downloading) {
      return (
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
      )
    }

    // Complete: nothing to fetch, and the row's Run/Stop already says it is on disk.
    if (artifact.complete) return null

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
