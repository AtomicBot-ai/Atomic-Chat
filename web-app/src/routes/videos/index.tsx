import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { VideoGenerationPage } from '@/containers/videos/VideoGenerationPage'
import { PlatformGuard } from '@/lib/platform/PlatformGuard'
import { PlatformFeature } from '@/lib/platform/types'

type SearchParams = {
  /** Family id to preselect, e.g. `ltx-2`. */
  model?: string
  /** Quant id within that family, e.g. `q4_k_m`. */
  quant?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.videos.index as any)({
  component: VideosRoute,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    model: typeof search.model === 'string' ? search.model : undefined,
    quant: typeof search.quant === 'string' ? search.quant : undefined,
  }),
})

function VideosRoute() {
  const search = Route.useSearch() as SearchParams
  return (
    <PlatformGuard feature={PlatformFeature.MEDIA_GENERATION}>
      <VideoGenerationPage search={search} />
    </PlatformGuard>
  )
}
