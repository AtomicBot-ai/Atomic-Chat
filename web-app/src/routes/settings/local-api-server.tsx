import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/**
 * The Local API Server page lives at Settings > API. This older address is
 * still reachable by URL and from older links, so it forwards rather than
 * 404s.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.local_api_server as any)({
  beforeLoad: () => {
    throw redirect({ to: route.settings.api })
  },
})
