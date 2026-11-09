import { useEffect } from 'react'

import { Button } from '@/components/ui/button'
import {
  Dialog,
  DialogContent,
  DialogDescription,
  DialogFooter,
  DialogHeader,
  DialogTitle,
} from '@/components/ui/dialog'
import { AgentIcon } from '@/containers/AgentIcon'
import { useAgentActions } from '@/hooks/useAgentActions'
import { useTranslation } from '@/i18n/react-i18next-compat'
import {
  answerAgentSwitch,
  registerAgentReopen,
  useAgentSwitchQuestion,
} from '@/utils/agentSwitchGuard'

/**
 * Asks before a model switch cuts off the agents Atomic Chat opened
 * (`agentSwitchGuard.ts`), and lends the switch the Connect action that
 * opens them again on the new model. Closing it is a no.
 */
export default function AgentSwitchDialog() {
  const { t } = useTranslation()
  const pending = useAgentSwitchQuestion((state) => state.pending)
  const { connect } = useAgentActions()

  useEffect(() => registerAgentReopen(connect), [connect])

  if (!pending) return null

  return (
    <Dialog
      open
      onOpenChange={(open) => {
        if (!open) answerAgentSwitch(false)
      }}
    >
      <DialogContent showCloseButton={false} data-testid="agent-switch-dialog">
        <DialogHeader>
          <DialogTitle>
            {t('api:agentSwitch.title', { model: pending.model })}
          </DialogTitle>
          <DialogDescription>
            {t('api:agentSwitch.description', {
              count: pending.agents.length,
            })}
          </DialogDescription>
        </DialogHeader>
        <ul className="flex flex-col gap-2">
          {pending.agents.map((agent) => (
            <li
              key={agent.id}
              className="flex items-center gap-3 rounded-md border bg-secondary px-3 py-2 text-sm"
            >
              <AgentIcon agent={agent} />
              <span className="font-medium">{agent.name}</span>
            </li>
          ))}
        </ul>
        <p className="text-sm text-muted-foreground">
          {t('api:agentSwitch.consequence', {
            model: pending.model,
            count: pending.agents.length,
          })}
        </p>
        {pending.cloudProvider && (
          <p className="text-sm text-muted-foreground">
            {t('api:agentSwitch.cloud', {
              model: pending.model,
              provider: pending.cloudProvider,
            })}
          </p>
        )}
        <DialogFooter>
          <Button variant="ghost" onClick={() => answerAgentSwitch(false)}>
            {t('api:agentSwitch.cancel')}
          </Button>
          <Button autoFocus onClick={() => answerAgentSwitch(true)}>
            {t('api:agentSwitch.confirm')}
          </Button>
        </DialogFooter>
      </DialogContent>
    </Dialog>
  )
}
