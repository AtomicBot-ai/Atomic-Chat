import { useEffect } from 'react'

import { useServiceHub } from '@/hooks/useServiceHub'
import { PlatformFeatures } from '@/lib/platform/const'
import { PlatformFeature } from '@/lib/platform/types'
import { useImageGenerationStore } from '@/stores/image-generation-store'

/**
 * Binds the image-generation store to the native plugin for the life of the
 * app. Renders nothing.
 *
 * Mounted once at the root rather than on the Images page: a job lives in the
 * plugin, and the run loop and the event subscription have to outlive a
 * navigation away from the page — otherwise leaving it mid-batch would strand
 * the remaining runs and drop the outputs of the one in flight.
 */
export function ImageGenerationProvider() {
  // Read through the hook so a missing hub throws where the rest of the app
  // expects it to, rather than inside an effect.
  useServiceHub()
  const bind = useImageGenerationStore((state) => state.bind)
  const unbind = useImageGenerationStore((state) => state.unbind)

  useEffect(() => {
    if (!PlatformFeatures[PlatformFeature.MEDIA_GENERATION]) return
    void bind()
    return unbind
  }, [bind, unbind])

  return null
}

export default ImageGenerationProvider
