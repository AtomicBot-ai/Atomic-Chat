import { createFileRoute, redirect } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { ImageGenerationPage } from '@/containers/images/ImageGenerationPage'
import { isImageWorkflowId } from '@/lib/diffusion/workflows'
import { PlatformGuard } from '@/lib/platform/PlatformGuard'
import { PlatformFeature } from '@/lib/platform/types'
import type { ImageWorkflowId } from '@/services/diffusion/types'

type SearchParams = {
  /** Family id to preselect, e.g. `z-image`. */
  model?: string
  /** Quant id within that family, e.g. `q4_k_m`. */
  quant?: string
}

/**
 * `/images/<workflow>` — the same page as `/images/`, opened on one of the
 * image-to-image workflows. The route is the source of truth for which
 * workflow is active, so every sidebar entry is a plain link and a deep
 * link lands on the right form. `create` lives at `/images/`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.images.workflow as any)({
  component: ImagesWorkflowRoute,
  validateSearch: (search: Record<string, unknown>): SearchParams => ({
    model: typeof search.model === 'string' ? search.model : undefined,
    quant: typeof search.quant === 'string' ? search.quant : undefined,
  }),
  beforeLoad: ({ params }: { params: { workflow: string } }) => {
    if (!isImageWorkflowId(params.workflow) || params.workflow === 'create') {
      throw redirect({ to: route.images.index })
    }
  },
})

function ImagesWorkflowRoute() {
  const { workflow } = Route.useParams() as { workflow: ImageWorkflowId }
  const search = Route.useSearch() as SearchParams
  return (
    <PlatformGuard feature={PlatformFeature.MEDIA_GENERATION}>
      <ImageGenerationPage workflow={workflow} search={search} />
    </PlatformGuard>
  )
}
