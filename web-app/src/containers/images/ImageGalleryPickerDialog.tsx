import { memo } from 'react'
import { IconLoader2, IconPhoto } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { useImageGallery } from '@/hooks/useImageGallery'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { GalleryImageItem } from '@/services/diffusion/types'
import { ImageGalleryTile } from './ImageGalleryTile'

type ImageGalleryPickerDialogProps = {
  open: boolean
  onOpenChange: (open: boolean) => void
  /** The picked image; the dialog closes itself. */
  onPick: (item: GalleryImageItem) => void
}

/**
 * Pick one of the generated images as an input: the same thumbnails as the
 * gallery, one click to choose. Runs on the gallery store, so what was
 * generated a moment ago is already here.
 */
export const ImageGalleryPickerDialog = memo(function ImageGalleryPickerDialog({
  open,
  onOpenChange,
  onPick,
}: ImageGalleryPickerDialogProps) {
  const { t } = useTranslation()
  const gallery = useImageGallery()

  const pick = (id: string) => {
    const item = gallery.items.find((entry) => entry.id === id)
    if (!item) return
    onPick(item)
    onOpenChange(false)
  }

  return (
    <Dialog open={open} onOpenChange={onOpenChange}>
      <DialogContent
        className="max-h-[80vh] w-[min(720px,calc(100vw-2rem))] max-w-none overflow-y-auto"
        data-testid="image-gallery-picker"
      >
        <DialogHeader>
          <DialogTitle>{t('images:form.galleryPickerTitle')}</DialogTitle>
          <DialogDescription>
            {t('images:form.galleryPickerDescription')}
          </DialogDescription>
        </DialogHeader>
        {gallery.initialized && gallery.items.length === 0 ? (
          <div className="flex flex-col items-center gap-2 py-10 text-sm text-muted-foreground">
            <IconPhoto size={28} stroke={1.5} />
            {t('images:form.galleryPickerEmpty')}
          </div>
        ) : (
          <div className="space-y-3">
            <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
              {gallery.items.map((item) => (
                <ImageGalleryTile
                  key={item.id}
                  item={item}
                  current={false}
                  selected={false}
                  onClick={pick}
                  onOpen={pick}
                />
              ))}
            </div>
            {gallery.hasMore && (
              <div className="flex justify-center">
                <Button
                  variant="ghost"
                  size="sm"
                  disabled={gallery.loading}
                  onClick={() => void gallery.loadMore()}
                >
                  {gallery.loading && (
                    <IconLoader2 size={14} className="animate-spin" />
                  )}
                  {t('images:gallery.loadMore')}
                </Button>
              </div>
            )}
          </div>
        )}
      </DialogContent>
    </Dialog>
  )
})

export default ImageGalleryPickerDialog
