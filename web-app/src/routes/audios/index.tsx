import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { AudioGenerationPage } from '@/containers/audios/AudioGenerationPage'
import { PlatformGuard } from '@/lib/platform/PlatformGuard'
import { PlatformFeature } from '@/lib/platform/types'

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.audios.index as any)({
  component: AudiosRoute,
})

function AudiosRoute() {
  return (
    <PlatformGuard feature={PlatformFeature.AUDIO_GENERATION}>
      <AudioGenerationPage />
    </PlatformGuard>
  )
}
