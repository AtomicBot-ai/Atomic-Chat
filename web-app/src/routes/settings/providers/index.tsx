import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { InferenceEnginesOverview } from '@/containers/engines/InferenceEnginesOverview'

/**
 * Models Hub → Inference engines: the grouped overview. Each engine's own
 * page stays `/settings/providers/$providerName`.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.model_providers as any)({
  component: InferenceEnginesOverview,
})
