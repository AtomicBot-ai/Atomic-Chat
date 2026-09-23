import type { GalleryImageItem } from '@/services/diffusion/types'
import { useImageGalleryStore } from '@/stores/image-gallery-store'
import { useMediaGallery, type MediaGalleryHandle } from './useMediaGallery'

export type ImageGalleryHandle = MediaGalleryHandle<GalleryImageItem>

/** The image gallery as the Images page sees it. */
export function useImageGallery(): ImageGalleryHandle {
  return useMediaGallery(useImageGalleryStore)
}
