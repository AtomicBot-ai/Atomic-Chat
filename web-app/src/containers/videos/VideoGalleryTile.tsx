import { memo, useEffect, useRef, type MouseEvent } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { IconCircleCheckFilled, IconMovie } from '@tabler/icons-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import { formatSeconds } from '@/lib/video/duration'
import type { GalleryVideoItem } from '@/services/diffusion/types'

type VideoGalleryTileProps = {
  item: GalleryVideoItem
  /** Shown large in the viewer. */
  current: boolean
  /** Part of a multi-selection (two or more tiles); Delete acts on all of them. */
  selected: boolean
  onClick: (id: string, modifiers: { shift: boolean; meta: boolean }) => void
  onOpen: (id: string) => void
  /** The tile came into view without a poster: the page may render one. */
  onVisibleWithoutPoster?: (item: GalleryVideoItem) => void
}

/**
 * One clip in the grid: its poster, or a neutral mark until one exists, and
 * the duration in the corner. The poster is an `<img>` over the asset
 * protocol like the image thumbnails; the clip itself is never loaded here.
 */
export const VideoGalleryTile = memo(function VideoGalleryTile({
  item,
  current,
  selected,
  onClick,
  onOpen,
  onVisibleWithoutPoster,
}: VideoGalleryTileProps) {
  const { t } = useTranslation()
  const ref = useRef<HTMLButtonElement>(null)
  const poster = item.posterPath ? convertFileSrc(item.posterPath) : null

  // A clip without a poster asks for one the first time it is on screen, so
  // an old gallery is filled in as it is scrolled, not all at once.
  useEffect(() => {
    if (poster || !onVisibleWithoutPoster || !ref.current) return
    if (typeof IntersectionObserver === 'undefined') {
      onVisibleWithoutPoster(item)
      return
    }
    const observer = new IntersectionObserver((entries) => {
      if (entries.some((entry) => entry.isIntersecting)) {
        onVisibleWithoutPoster(item)
        observer.disconnect()
      }
    })
    observer.observe(ref.current)
    return () => observer.disconnect()
  }, [poster, item, onVisibleWithoutPoster])

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick(item.id, {
      shift: event.shiftKey,
      meta: event.metaKey || event.ctrlKey,
    })
  }

  return (
    <button
      ref={ref}
      type="button"
      data-testid={`video-tile-${item.id}`}
      data-current={current ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={t('videos:gallery.tileLabel', {
        size: `${item.width}×${item.height}`,
        seconds: formatSeconds(item.durationSecs),
      })}
      title={item.recipe.prompt}
      onClick={handleClick}
      onDoubleClick={() => onOpen(item.id)}
      className={cn(
        'group relative aspect-square cursor-pointer overflow-hidden rounded-lg bg-secondary outline-none transition-[box-shadow] animate-in fade-in-0 zoom-in-95 duration-500 hover:ring-2 hover:ring-border focus-visible:ring-2 focus-visible:ring-ring',
        selected && 'ring-2 ring-primary/50'
      )}
    >
      {poster ? (
        <img
          src={poster}
          alt=""
          loading="lazy"
          decoding="async"
          draggable={false}
          width={item.width}
          height={item.height}
          className="size-full object-cover"
        />
      ) : (
        <span
          className="flex size-full items-center justify-center text-muted-foreground"
          data-testid="video-tile-poster-missing"
        >
          <IconMovie size={22} stroke={1.5} />
        </span>
      )}
      <span
        className="pointer-events-none absolute bottom-1 right-1 rounded-md bg-black/55 px-1.5 py-0.5 font-mono text-[10px] tabular-nums text-white backdrop-blur-sm"
        data-testid="video-tile-duration"
      >
        {formatSeconds(item.durationSecs)}s
      </span>
      {selected && (
        <span className="absolute right-1 top-1 rounded-full bg-background/90 text-primary">
          <IconCircleCheckFilled size={18} />
        </span>
      )}
    </button>
  )
})

export default VideoGalleryTile
