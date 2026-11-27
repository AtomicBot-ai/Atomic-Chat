import { createFileRoute, redirect } from '@tanstack/react-router'
import { useEffect } from 'react'
import { ConversationHome } from '@/components/ConversationHome'
import { useThreads } from '@/hooks/useThreads'
import { AGENT_HOME_DRAFT } from '@/lib/pi/navigation'
import { currentDesktopPlatform } from '@/constants/integrations'
import { TaskComposer } from '@/containers/TaskComposer'

export const Route = createFileRoute('/agent/')({
  beforeLoad: () => {
    if (!currentDesktopPlatform()) throw redirect({ to: '/' })
  },
  component: AgentHome,
})
function AgentHome() {
  useEffect(() => {
    useThreads.getState().setCurrentThreadId(undefined)
  }, [])
  return (
    <ConversationHome workspaceKey={AGENT_HOME_DRAFT} piAgent>
      <TaskComposer />
    </ConversationHome>
  )
}
