import { memo, useEffect, useRef } from 'react'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { GalleryImageItem } from '@/services/diffusion/types'
import { ImageGalleryTile } from './ImageGalleryTile'

type ImageGalleryGridProps = {
  items: GalleryImageItem[]
  selectedId: string | null
  selectedIds: string[]
  hasMore: boolean
  loading: boolean
  onSelect: (id: string, modifiers: { shift: boolean; meta: boolean }) => void
  onOpen: (id: string) => void
  onLoadMore: () => void
}

/**
 * The thumbnail grid with a sentinel at the bottom that pulls the next page
 * into view. A visible "Load more" button stays as the fallback for
 * environments without `IntersectionObserver` and for keyboard users.
 */
export const ImageGalleryGrid = memo(function ImageGalleryGrid({
  items,
  selectedId,
  selectedIds,
  hasMore,
  loading,
  onSelect,
  onOpen,
  onLoadMore,
}: ImageGalleryGridProps) {
  const { t } = useTranslation()
  const sentinelRef = useRef<HTMLDivElement>(null)
  const selectedSet = new Set(selectedIds)

  useEffect(() => {
    const sentinel = sentinelRef.current
    if (!sentinel || !hasMore) return
    if (typeof IntersectionObserver === 'undefined') return
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) onLoadMore()
    })
    observer.observe(sentinel)
    return () => observer.disconnect()
  }, [hasMore, onLoadMore, items.length])

  return (
    <div className="space-y-3" data-testid="image-gallery-grid">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(112px,1fr))] gap-2">
        {items.map((item) => (
          <ImageGalleryTile
            key={item.id}
            item={item}
            current={item.id === selectedId}
            selected={selectedSet.has(item.id)}
            onClick={onSelect}
            onOpen={onOpen}
          />
        ))}
      </div>
      {hasMore && (
        <div ref={sentinelRef} className="flex justify-center py-2">
          <Button
            variant="ghost"
            size="sm"
            disabled={loading}
            onClick={onLoadMore}
          >
            {loading && <IconLoader2 size={14} className="animate-spin" />}
            {t('images:gallery.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
})

export default ImageGalleryGrid
