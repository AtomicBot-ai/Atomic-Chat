import { memo, useEffect, useRef } from 'react'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type { GalleryImageItem } from '@/services/diffusion/types'
import type { ImageJobProgress } from '@/services/diffusion/types'
import { ImageGalleryTile } from './ImageGalleryTile'
import { ImageGenerationPlaceholder } from './ImageGenerationPlaceholder'

type ImageGalleryGridProps = {
  items: GalleryImageItem[]
  selectedId: string | null
  selectedIds: string[]
  hasMore: boolean
  loading: boolean
  pendingCount?: number
  pendingSize?: { width: number; height: number }
  pendingProgress?: ImageJobProgress | null
  pendingStartedAtMs?: number
  pendingSelected?: boolean
  onSelectPending?: () => void
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
  pendingCount = 0,
  pendingSize = { width: 1024, height: 1024 },
  pendingProgress = null,
  pendingStartedAtMs = Date.now(),
  pendingSelected = false,
  onSelectPending,
  onSelect,
  onOpen,
  onLoadMore,
}: ImageGalleryGridProps) {
  const { t } = useTranslation()
  const sentinelRef = useRef<HTMLDivElement>(null)
  // The store always selects the open image; a check on that tile alone would
  // repeat the "current" ring, so checks appear only for a real multi-selection.
  const selectedSet = new Set(selectedIds.length > 1 ? selectedIds : [])

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
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
        {Array.from({ length: pendingCount }, (_, index) => (
          <button
            key={`pending-${index}`}
            type="button"
            className="min-w-0 cursor-pointer rounded-lg outline-none hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('images:progress.generatingImage')}
            aria-pressed={pendingSelected}
            data-testid={`gallery-pending-${index}`}
            onClick={onSelectPending}
          >
            <ImageGenerationPlaceholder
              variant="tile"
              width={pendingSize.width}
              height={pendingSize.height}
              progress={pendingProgress}
              startedAtMs={pendingStartedAtMs}
              index={index}
            />
          </button>
        ))}
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
