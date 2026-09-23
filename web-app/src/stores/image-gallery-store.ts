import { getServiceHub } from '@/hooks/useServiceHub'
import type { GalleryImageItem } from '@/services/diffusion/types'
import {
  createMediaGalleryStore,
  PAGE_SIZE,
  type MediaGalleryState,
} from '@/stores/media-gallery-store'

export { PAGE_SIZE }

export type ImageGalleryState = MediaGalleryState<GalleryImageItem>

/** The Images page's gallery: a paged, selectable view of `<data>/images`. */
export const useImageGalleryStore = createMediaGalleryStore<GalleryImageItem>({
  list: (options) => getServiceHub().diffusion().listGallery(options),
  logPrefix: '[images]',
})
