import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { route } from '@/constants/routes'
import { SERVER_AGENTS } from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import type { AgentState } from '@/lib/agent-status'
import { useAgentStatus } from '@/hooks/useAgentStatus'
import { useServerSetup } from '@/hooks/useServerSetup'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { detectIntegrationAgentsOnce } from '@/lib/integration-agent-detection'
import { isGuidedAgent } from '@/lib/integration-agent-setup'
import { cn } from '@/lib/utils'

/** The dot: green once it talks to the server, paler while only set up. */
const DOT: Record<AgentState, string> = {
  not_installed: 'bg-muted-foreground/40',
  installed: 'bg-muted-foreground/40',
  app_missing: 'bg-amber-400',
  configured: 'bg-emerald-400/50',
  opened: 'bg-emerald-400/50',
  connected: 'bg-emerald-400',
}

/**
 * The integration agents, in the Server's order, as a palette under the
 * Server navigation. An agent Atomic Chat can configure opens the setup guide
 * on Overview at its review; an editor set up by hand opens its card on All
 * integrations. Each says where it stands (`useAgentStatus`).
 */
export function NavServerAgents() {
  const { t } = useTranslation()
  const statusOf = useAgentStatus()

  useEffect(() => {
    detectIntegrationAgentsOnce()
  }, [])

  return (
    <div className="px-3 pb-4">
      <p className="mb-2 px-1 pt-3 text-xs font-medium text-muted-foreground">
        {t('common:navigation.agentsAndTools')}
      </p>
      <div className="space-y-0.5">
        {SERVER_AGENTS.map((agent) => {
          const { state, label: status } = statusOf(agent)
          const guided = isGuidedAgent(agent)
          return (
            <Link
              key={agent.id}
              to={guided ? route.api.index : route.launch.index}
              hash={guided ? undefined : agent.id}
              onClick={() => {
                if (guided)
                  useServerSetup
                    .getState()
                    .openGuide({ path: 'agent', agentId: agent.id })
              }}
              aria-label={`${agent.name}: ${status}`}
              className="flex items-center gap-2 rounded-md px-2 py-1.5 text-xs hover:bg-sidebar-foreground/8"
            >
              <span
                aria-hidden="true"
                className="inline-flex size-5 shrink-0 items-center justify-center overflow-hidden rounded [&>div]:size-5 [&_svg]:max-h-4 [&_svg]:max-w-4"
              >
                <AgentIcon agent={agent} />
              </span>
              <span className="min-w-0 flex-1 truncate">{agent.name}</span>
              <span
                aria-hidden="true"
                title={status}
                className={cn('size-1.5 shrink-0 rounded-full', DOT[state])}
              />
              <ChevronRight
                size={12}
                className="shrink-0 text-muted-foreground"
              />
            </Link>
          )
        })}
      </div>
    </div>
  )
}
