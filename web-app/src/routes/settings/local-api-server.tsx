import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

/**
 * The Local API Server moved out of Settings onto its own top-level screen.
 * This route was never listed in `SettingsMenu`, but it is still reachable by
 * URL and from older links, so it forwards rather than 404s.
 */
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.local_api_server as any)({
  beforeLoad: () => {
    throw redirect({ to: route.api.index })
  },
})
