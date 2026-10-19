import { useEffect } from 'react'
import { Link } from '@tanstack/react-router'
import { ChevronRight } from 'lucide-react'
import { route } from '@/constants/routes'
import { INTEGRATION_AGENTS } from '@/constants/integrations'
import { AgentIcon } from '@/containers/AgentIcon'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { detectIntegrationAgentsOnce } from '@/lib/integration-agent-detection'
import { useLaunchStore } from '@/stores/launch-store'
import { cn } from '@/lib/utils'

/**
 * The integration agents as a palette under the Server navigation. Each row
 * opens that agent's card on the Integrations page; the dot says whether the
 * agent is installed on this machine.
 */
export function NavServerAgents() {
  const { t } = useTranslation()
  const installed = useLaunchStore((state) => state.installed)

  useEffect(() => {
    detectIntegrationAgentsOnce()
  }, [])

  return (
    <div className="px-3 pb-4">
      <p className="mb-2 px-1 pt-3 text-xs font-medium text-muted-foreground">
        {t('common:navigation.agentsAndTools')}
      </p>
      <div className="space-y-0.5">
        {INTEGRATION_AGENTS.map((agent) => {
          const status = installed[agent.id]
            ? t('common:navigation.installed')
            : t('common:navigation.notInstalled')
          return (
            <Link
              key={agent.id}
              to={route.launch.index}
              hash={agent.id}
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
                className={cn(
                  'size-1.5 shrink-0 rounded-full',
                  installed[agent.id]
                    ? 'bg-emerald-400'
                    : 'bg-muted-foreground/40'
                )}
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
