import { useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { useVideoGenerationStore } from '@/stores/video-generation-store'

/**
 * Binds the video job store to the core's event stream for the life of the
 * app. Renders nothing. Mounted once at the root beside the image provider,
 * for the same reason: a job lives in the core, and the wait for it and the
 * poster that follows must outlive a navigation away from the Video page.
 */
export function VideoGenerationProvider() {
  useServiceHub()
  const bind = useVideoGenerationStore((state) => state.bind)
  const unbind = useVideoGenerationStore((state) => state.unbind)

  useEffect(() => {
    if (!PlatformFeatures[PlatformFeature.MEDIA_GENERATION]) return
    void bind()
    return unbind
  }, [bind, unbind])

  return null
}

export default VideoGenerationProvider
