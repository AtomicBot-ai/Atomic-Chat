import { createFileRoute, redirect } from '@tanstack/react-router'
import { route } from '@/constants/routes'

// MCP management moved to the Connectors page (sidebar). The route stays as a
// redirect so old deep links keep working.
// eslint-disable-next-line @typescript-eslint/no-explicit-any
export const Route = createFileRoute(route.settings.mcp_servers as any)({
  beforeLoad: () => {
    throw redirect({ to: route.connectors.index })
  },
})
