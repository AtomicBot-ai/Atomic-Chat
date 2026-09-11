import { memo, type MouseEvent } from 'react'
import { convertFileSrc } from '@tauri-apps/api/core'
import { IconCircleCheckFilled } from '@tabler/icons-react'

import { useTranslation } from '@/i18n/react-i18next-compat'
import { cn } from '@/lib/utils'
import type { GalleryImageItem } from '@/services/diffusion/types'

type ImageGalleryTileProps = {
  item: GalleryImageItem
  /** Shown large in the viewer. */
  current: boolean
  /** Part of the multi-selection. */
  selected: boolean
  onClick: (id: string, modifiers: { shift: boolean; meta: boolean }) => void
  onOpen: (id: string) => void
}

/**
 * One thumbnail in the grid.
 *
 * The `<img>` points at the asset protocol through `convertFileSrc` and is
 * loaded lazily by the browser. It is never `fetch()`ed: WebView2 cannot
 * deliver large bodies over the asset protocol (see `chatInput/imageFromPath`),
 * and a thumbnail is exactly what an `<img>` tag is for.
 */
export const ImageGalleryTile = memo(function ImageGalleryTile({
  item,
  current,
  selected,
  onClick,
  onOpen,
}: ImageGalleryTileProps) {
  const { t } = useTranslation()
  const src = convertFileSrc(item.thumbnailPath ?? item.path)

  const handleClick = (event: MouseEvent<HTMLButtonElement>) => {
    onClick(item.id, {
      shift: event.shiftKey,
      meta: event.metaKey || event.ctrlKey,
    })
  }

  return (
    <button
      type="button"
      data-testid={`gallery-tile-${item.id}`}
      data-current={current ? 'true' : undefined}
      data-selected={selected ? 'true' : undefined}
      aria-pressed={selected}
      aria-label={t('images:gallery.tileLabel', {
        size: `${item.width}×${item.height}`,
      })}
      title={item.recipe.prompt}
      onClick={handleClick}
      onDoubleClick={() => onOpen(item.id)}
      className={cn(
        'group relative aspect-square overflow-hidden rounded-md bg-secondary outline-none transition-[box-shadow] focus-visible:ring-2 focus-visible:ring-ring',
        current && 'ring-2 ring-primary',
        selected && !current && 'ring-2 ring-primary/50'
      )}
    >
      <img
        src={src}
        alt=""
        loading="lazy"
        decoding="async"
        draggable={false}
        width={item.width}
        height={item.height}
        className="size-full object-cover"
      />
      {selected && (
        <span className="absolute right-1 top-1 rounded-full bg-background/90 text-primary">
          <IconCircleCheckFilled size={18} />
        </span>
      )}
    </button>
  )
})

export default ImageGalleryTile
