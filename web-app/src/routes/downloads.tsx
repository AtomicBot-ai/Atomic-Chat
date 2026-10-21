import { createFileRoute } from '@tanstack/react-router'

import { route } from '@/constants/routes'
import { DownloadsPage } from '@/containers/downloads/DownloadsPage'

/**
 * Models Hub → Downloads: what is on this computer and how much room it
 * takes. `/hub?installed=true` stays the Hub's own "installed" filter.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.downloads as any)({
  component: DownloadsPage,
})
