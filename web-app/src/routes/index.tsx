/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import HeaderPage from '@/containers/HeaderPage'
import { useTranslation } from '@/i18n/react-i18next-compat'
import { useTools } from '@/hooks/useTools'
import { cn } from '@/lib/utils'

import { useModelProvider } from '@/hooks/useModelProvider'
import SetupScreen from '@/containers/SetupScreen'
import { route } from '@/constants/routes'
import { isOnboardingPending } from '@/lib/onboarding'
import { useCallback, useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { AgentWorkspaceLayout } from '@/containers/AgentWorkspaceLayout'
import { useServiceHub } from '@/hooks/useServiceHub'
import { resolveAgentWorkspaceRoot } from '@/services/agent/tauri'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
  agentSkill?: string
}

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
      agentSkill:
        typeof search.agentSkill === 'string' ? search.agentSkill : undefined,
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const serviceHub = useServiceHub()
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const agentSkill = search.agentSkill
  const { setCurrentThreadId } = useThreads()
  const agentWorkspace = useAgentMode(
    (state) => state.workspaces[TEMPORARY_CHAT_ID]
  )
  useTools()

  const addExternalAgentRoot = useCallback(async () => {
    const selected = await serviceHub.dialog().open({
      multiple: false,
      directory: true,
    })
    if (typeof selected !== 'string') return

    const root = await resolveAgentWorkspaceRoot(selected)
    useAgentMode.getState().addExternalRoot(TEMPORARY_CHAT_ID, {
      ...root,
      canEdit: true,
    })
  }, [serviceHub])

  //* После авто-выхода без перемонтирования роутера — поднимаем флаг, иначе ре-рендер не гарантирован
  const [setupSkippedThisSession, setSetupSkippedThisSession] = useState(false)

  // Shared with the startup auto-start gate so the two can never disagree about
  // onboarding. Also covers the dev-only FORCE_ONBOARDING flag, which enters
  // onboarding despite installed models without blocking the way out.
  const onboardingPending =
    !setupSkippedThisSession && isOnboardingPending(providers)

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (onboardingPending) {
    return <SetupScreen onSkipped={() => setSetupSkippedThisSession(true)} />
  }

  return (
    <AgentWorkspaceLayout
      threadId={TEMPORARY_CHAT_ID}
      workspace={agentWorkspace ?? { externalRoots: [] }}
      onAddExternal={() => void addExternalAgentRoot()}
      refreshKey={0}
      // The home composer has no thread yet, so no agent workspace to browse:
      // only the run settings live in its right column.
      filesEnabled={false}
    >
      <div className="flex h-full w-full min-w-0 flex-col justify-center">
        <HeaderPage>
          <div className="flex items-center gap-2 w-full pr-2">
            <DropdownModelProvider />
          </div>
        </HeaderPage>
        <div
          className={cn(
            'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
          )}
        >
          <div className={cn('mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20')}>
            <div className={cn('text-center mb-4')}>
              <h1 className={cn('text-2xl mt-2 font-studio font-medium')}>
                {t('chat:description')}
              </h1>
            </div>
            <div className="flex-1 shrink-0">
              <ChatInput
                showSpeedToken={false}
                model={threadModel}
                initialMessage={true}
                preselectedAgentSkillName={agentSkill}
              />
            </div>
          </div>
        </div>
      </div>
    </AgentWorkspaceLayout>
  )
}
