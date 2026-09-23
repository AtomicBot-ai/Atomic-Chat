import { getServiceHub } from '@/hooks/useServiceHub'
import type { GalleryVideoItem } from '@/services/diffusion/types'
import {
  createMediaGalleryStore,
  type MediaGalleryState,
} from '@/stores/media-gallery-store'

export type VideoGalleryState = MediaGalleryState<GalleryVideoItem>

/**
 * The Video page's gallery: a paged, selectable view of `<data>/videos`. A
 * poster that lands after a clip was listed replaces the item through
 * `patch`, so the tile fills in without a reload.
 */
export const useVideoGalleryStore = createMediaGalleryStore<GalleryVideoItem>({
  list: (options) => getServiceHub().diffusion().listVideoGallery(options),
  logPrefix: '[videos]',
})
