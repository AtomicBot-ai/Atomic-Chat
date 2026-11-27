import type { ReactNode } from 'react'
import { LazyAtomicLogo } from '@/components/LazyAtomicLogo'
import ConversationHeader from '@/components/ConversationHeader'
import { AgentWorkspaceLayout } from '@/containers/AgentWorkspaceLayout'
import { useAgentMode } from '@/hooks/useAgentMode'
import { useServiceHub } from '@/hooks/useServiceHub'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { addExternalAgentFolder } from '@/lib/agent-workspace-actions'

export function ConversationHome({
  workspaceKey,
  piAgent = false,
  children,
}: {
  workspaceKey: string
  piAgent?: boolean
  children: ReactNode
}) {
  const { t } = useTranslation()
  const hub = useServiceHub()
  const workspace = useAgentMode((state) => state.workspaces[workspaceKey])
  return (
    <AgentWorkspaceLayout
      threadId={workspaceKey}
      workspace={workspace ?? { externalRoots: [] }}
      piAgent={piAgent}
      filesEnabled={Boolean(
        workspace?.primaryRoot || workspace?.externalRoots.length
      )}
      onAddExternal={() => void addExternalAgentFolder(hub, workspaceKey)}
      refreshKey={0}
    >
      <div className="flex h-full w-full min-w-0 flex-col">
        <ConversationHeader mode={piAgent ? 'agent' : 'chat'} showModeSwitch />
        <div className="flex min-h-0 flex-1 flex-col overflow-y-auto px-3 pb-20">
          <div className="mx-auto my-auto w-full py-4 md:w-4/5 xl:w-4/6">
            <div className="mb-4 text-center">
              <LazyAtomicLogo />
              <h1 className="mt-2 font-studio text-2xl font-medium">
                {t('chat:description')}
              </h1>
            </div>
            {children}
          </div>
        </div>
      </div>
    </AgentWorkspaceLayout>
  )
}
