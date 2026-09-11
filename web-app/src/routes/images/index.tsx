import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { ImageGenerationPage } from '@/containers/images/ImageGenerationPage'
import { PlatformGuard } from '@/lib/platform/PlatformGuard'
import { PlatformFeature } from '@/lib/platform/types'

type SearchParams = {
  /** Family id to preselect, e.g. `z-image`. */
  model?: string
  /** Quant id within that family, e.g. `q4_k_m`. */
  quant?: string
}

// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.images.index as any)({
  component: ImagesRoute,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    model: typeof search.model === 'string' ? search.model : undefined,
    quant: typeof search.quant === 'string' ? search.quant : undefined,
  }),
})

function ImagesRoute() {
  const search = Route.useSearch() as SearchParams
  return (
    <PlatformGuard feature={PlatformFeature.MEDIA_GENERATION}>
      <ImageGenerationPage search={search} />
    </PlatformGuard>
  )
}
