import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { ApiPage } from '@/routes/api/index'

/** Settings > API: the Local API Server page, inside the Settings frame. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.api as any)({
  component: ApiPage,
})
