import { memo, useEffect, useState } from 'react'
import { IconPhoto, IconPhotoPlus, IconX } from '@tabler/icons-react'
import { toast } from 'sonner'

import { Button } from '@/components/ui/button'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { SOURCE_IMAGE_EXTENSIONS } from '@/lib/diffusion/workflows'
import { cn } from '@/lib/utils'
import { ImageGalleryPickerDialog } from './ImageGalleryPickerDialog'
import { useSourceImageUrl } from './useSourceImageUrl'

type ImageSourceDropzoneProps = {
  /** Absolute path of the picked image, or none. */
  path: string | null
  /** Called with the chosen path and its pixel size; `null` clears. */
  onPick: (
    picked: { path: string; width: number; height: number } | null
  ) => void
  /** A drag is over the window: light the target up. */
  dragOver?: boolean
  disabled?: boolean
  /** Below the thumbnail: e.g. the image's pixel size. */
  caption?: string
  className?: string
  testId?: string
}

/**
 * "Click or drop an image": a dashed card that opens the file dialog, and
 * shows the picked picture once there is one. Drops are handled window-wide
 * by the form (Tauri reports them for the whole window), so this card only
 * reflects that a drag is in progress.
 */
export const ImageSourceDropzone = memo(function ImageSourceDropzone({
  path,
  onPick,
  dragOver,
  disabled,
  caption,
  className,
  testId = 'image-source-dropzone',
}: ImageSourceDropzoneProps) {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { url, size, error } = useSourceImageUrl(path)
  const [picking, setPicking] = useState(false)
  const [galleryOpen, setGalleryOpen] = useState(false)

  // The read failed (too large, unreadable): drop the pick and say why.
  useEffect(() => {
    if (!error || !path) return
    toast.error(t('images:form.sourceUnreadable'), { description: error })
    onPick(null)
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [error])

  // The picture decoded: report its size so the form can do its size maths.
  useEffect(() => {
    if (path && size) onPick({ path, width: size.width, height: size.height })
    // eslint-disable-next-line react-hooks/exhaustive-deps
  }, [size?.width, size?.height])

  const pick = async () => {
    if (disabled || picking) return
    setPicking(true)
    try {
      const selected = await serviceHub.dialog().open({
        multiple: false,
        filters: [
          { name: t('images:form.imageFiles'), extensions: [...SOURCE_IMAGE_EXTENSIONS] },
        ],
      })
      const chosen = Array.isArray(selected) ? selected[0] : selected
      if (chosen) onPick({ path: chosen, width: 0, height: 0 })
    } finally {
      setPicking(false)
    }
  }

  if (path && url) {
    return (
      <div
        className={cn('relative overflow-hidden rounded-2xl border border-border bg-secondary/40', className)}
        data-testid={testId}
      >
        <img
          src={url}
          alt=""
          draggable={false}
          className="mx-auto max-h-56 w-full object-contain"
        />
        <div className="flex items-center justify-between gap-2 px-3 py-1.5 text-[11px] text-muted-foreground">
          <span className="truncate" title={path}>
            {path.split(/[\\/]/).pop()}
          </span>
          {caption && <span className="shrink-0 tabular-nums">{caption}</span>}
        </div>
        <Button
          type="button"
          variant="outline"
          size="icon-sm"
          className="absolute right-2 top-2 bg-background/80 backdrop-blur"
          aria-label={t('images:form.removeImage')}
          disabled={disabled}
          onClick={() => onPick(null)}
        >
          <IconX size={14} />
        </Button>
      </div>
    )
  }

  return (
    <div className={cn('flex flex-col items-center gap-1.5', className)}>
      <button
        type="button"
        disabled={disabled}
        onClick={() => void pick()}
        className={cn(
          'flex min-h-36 w-full flex-col items-center justify-center gap-2 rounded-2xl border border-dashed border-border bg-secondary/30 px-4 py-6 text-sm text-muted-foreground transition-colors hover:border-foreground/40 hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60',
          dragOver && 'border-primary bg-primary/5 text-foreground'
        )}
        data-testid={testId}
      >
        <IconPhotoPlus size={24} stroke={1.5} />
        <span>{t('images:form.dropzone')}</span>
      </button>
      {/* The other place a picture comes from: something generated here. */}
      <button
        type="button"
        disabled={disabled}
        onClick={() => setGalleryOpen(true)}
        className="flex items-center gap-1 text-xs text-muted-foreground transition-colors hover:text-foreground disabled:cursor-not-allowed disabled:opacity-60"
        data-testid={`${testId}-gallery`}
      >
        <IconPhoto size={13} />
        {t('images:form.fromGallery')}
      </button>
      <ImageGalleryPickerDialog
        open={galleryOpen}
        onOpenChange={setGalleryOpen}
        onPick={(item) =>
          onPick({ path: item.path, width: item.width, height: item.height })
        }
      />
    </div>
  )
})

export default ImageSourceDropzone
