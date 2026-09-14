import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { validateCloudSearch } from '@/lib/cloud-search'
import { CloudPage } from '@/routes/cloud/index'

/** Settings > Cloud: connecting cloud providers, inside the Settings frame. */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.cloud as any)({
  component: CloudPage,
  validateSearch: validateCloudSearch,
})
