import type { GalleryVideoItem } from '@/services/diffusion/types'
import { useVideoGalleryStore } from '@/stores/video-gallery-store'
import { useMediaGallery, type MediaGalleryHandle } from './useMediaGallery'

export type VideoGalleryHandle = MediaGalleryHandle<GalleryVideoItem>

/** The video gallery as the Video page sees it. */
export function useVideoGallery(): VideoGalleryHandle {
  return useMediaGallery(useVideoGalleryStore)
}
