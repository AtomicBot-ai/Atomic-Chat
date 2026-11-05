import { createFileRoute, useSearch } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { InferenceEnginesOverview } from '@/containers/engines/InferenceEnginesOverview'

type EnginesSearch = {
  /**
   * An engine whose row opens unfolded (`engineSettingsLink`). Not `engine`,
   * which the Hub's search already types as a model format.
   */
  openEngine?: string
  /** That engine's update is a reinstall: its setup asks to confirm it. */
  engineUpdate?: boolean
}

/**
 * Models Hub → Inference engines: the grouped overview. Each engine's own
 * page stays `/settings/providers/$providerName`, for its models.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_providers as any)({
  component: EnginesRoute,
  validateSearch: (search: Record<string, unknown>): EnginesSearch => {
    // Absent stays absent, so the URL never carries "undefined".
    const openEngine = search?.openEngine
    if (typeof openEngine !== 'string' || openEngine.length === 0) return {}
    return {
      openEngine,
      ...(search?.engineUpdate === true || search?.engineUpdate === 'true'
        ? { engineUpdate: true }
        : {}),
    }
  },
})

function EnginesRoute() {
  const { openEngine, engineUpdate } = useSearch({
    from: Route.id,
  }) as EnginesSearch
  return (
    <InferenceEnginesOverview
      openEngine={openEngine}
      engineUpdate={engineUpdate}
    />
  )
}
