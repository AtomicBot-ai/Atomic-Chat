import { memo, useEffect, useRef } from 'react'
import { IconLoader2 } from '@tabler/icons-react'

import { Button } from '@/components/ui/button'
import { ImageGenerationPlaceholder } from '@/containers/images/ImageGenerationPlaceholder'
import { useTranslation } from '@/i18n/react-i18next-compat'
import type {
  GalleryVideoItem,
  VideoJobProgress,
} from '@/services/diffusion/types'
import { VideoGalleryTile } from './VideoGalleryTile'

type VideoGalleryGridProps = {
  items: GalleryVideoItem[]
  selectedId: string | null
  selectedIds: string[]
  hasMore: boolean
  loading: boolean
  /** A clip is being made: one placeholder tile ahead of the list. */
  pending?: boolean
  pendingSize?: { width: number; height: number }
  pendingProgress?: VideoJobProgress | null
  pendingStartedAtMs?: number
  pendingSelected?: boolean
  onSelectPending?: () => void
  onSelect: (id: string, modifiers: { shift: boolean; meta: boolean }) => void
  onOpen: (id: string) => void
  onLoadMore: () => void
  onVisibleWithoutPoster?: (item: GalleryVideoItem) => void
}

/**
 * The poster grid, the same shape as the image grid, with a sentinel at the
 * bottom that pulls the next page into view and a "Load more" fallback.
 */
export const VideoGalleryGrid = memo(function VideoGalleryGrid({
  items,
  selectedId,
  selectedIds,
  hasMore,
  loading,
  pending = false,
  pendingSize = { width: 768, height: 512 },
  pendingProgress = null,
  pendingStartedAtMs = Date.now(),
  pendingSelected = false,
  onSelectPending,
  onSelect,
  onOpen,
  onLoadMore,
  onVisibleWithoutPoster,
}: VideoGalleryGridProps) {
  const { t } = useTranslation()
  const sentinelRef = useRef<HTMLDivElement>(null)
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
    <div className="space-y-3" data-testid="video-gallery-grid">
      <div className="grid grid-cols-[repeat(auto-fill,minmax(104px,1fr))] gap-2">
        {pending && (
          <button
            type="button"
            className="min-w-0 cursor-pointer rounded-lg outline-none hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring"
            aria-label={t('videos:progress.generatingVideo')}
            aria-pressed={pendingSelected}
            data-testid="gallery-pending-0"
            onClick={onSelectPending}
          >
            <ImageGenerationPlaceholder
              variant="tile"
              kind="video"
              width={pendingSize.width}
              height={pendingSize.height}
              progress={pendingProgress}
              startedAtMs={pendingStartedAtMs}
            />
          </button>
        )}
        {items.map((item) => (
          <VideoGalleryTile
            key={item.id}
            item={item}
            current={item.id === selectedId}
            selected={selectedSet.has(item.id)}
            onClick={onSelect}
            onOpen={onOpen}
            onVisibleWithoutPoster={onVisibleWithoutPoster}
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
            {t('videos:gallery.loadMore')}
          </Button>
        </div>
      )}
    </div>
  )
})

export default VideoGalleryGrid
