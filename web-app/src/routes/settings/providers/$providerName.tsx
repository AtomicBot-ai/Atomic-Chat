import {
  createFileRoute,
  redirect,
  useParams,
  useSearch,
} from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { EngineDetail } from '@/containers/engines/EngineDetail'
import { useModelProvider } from '@/hooks/useModelProvider'
import { isLocalEngineProvider } from '@/lib/cloud-providers'

// as route.threadsDetail
export const Route = createFileRoute('/settings/providers/$providerName')({
  /**
   * Cloud providers are configured on `/cloud` now. The route stays alive
   * because bookmarks, the model picker's gear and `DeleteProvider` all point
   * at it; it just forwards.
   *
   * `beforeLoad` rather than a redirect inside the component: it runs outside
   * React, so it cannot disturb the hook order of a 2800-line component. An
   * unresolved provider (zustand-persist not rehydrated yet on a cold start)
   * falls through to the page's own "no provider" render instead of bouncing.
   */
  beforeLoad: ({ params }) => {
    const provider = useModelProvider
      .getState()
      .getProviderByName(params.providerName)
    if (provider && !isLocalEngineProvider(provider)) {
      throw redirect({
        to: route.cloud.index,
        search: { provider: params.providerName },
      })
    }
  },
  component: ProviderDetail,
  validateSearch: (
    search: Record<string, unknown>
  ): { step?: string; engineUpdate?: boolean } => {
    // validate and parse the search params into a typed state
    return {
      step: String(search?.step),
      // The engine update banner's "Update" for a managed engine: its card
      // asks to confirm the reinstall.
      ...(search?.engineUpdate === true || search?.engineUpdate === 'true'
        ? { engineUpdate: true }
        : {}),
    }
  },
})

/** The engine's full page: its settings, models and helper models. */
function ProviderDetail() {
  const { providerName } = useParams({ from: Route.id })
  /// The engine update banner's "Update" for a managed engine lands here.
  const { engineUpdate } = useSearch({ from: Route.id })
  return (
    <EngineDetail providerName={providerName} engineUpdate={engineUpdate} />
  )
}
