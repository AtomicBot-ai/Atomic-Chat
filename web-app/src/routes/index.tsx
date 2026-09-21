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
import { hasPriorAppUse, isOnboardingPending } from '@/lib/onboarding'
import { localStorageKey } from '@/constants/localStorage'
import { useCallback, useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
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
  const { setCurrentThreadId, threads } = useThreads()
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

  //* After auto-logout without remounting the router — raise the flag, otherwise a re-render is not guaranteed
  const [setupSkippedThisSession, setSetupSkippedThisSession] = useState(false)
  const forceOnboarding =
    typeof FORCE_ONBOARDING !== 'undefined' && FORCE_ONBOARDING
  const hasPriorThread = Object.values(threads).some(
    (thread) => thread.id !== TEMPORARY_CHAT_ID
  )

  // Older builds could skip Welcome because a model/provider already existed
  // without persisting setup-completed. If that model or key was removed
  // later, Welcome incorrectly returned. Any usable provider or durable chat
  // is proof that first-run onboarding is over; migrate that proof once so
  // deleting everything later still lands on the normal empty composer.
  useEffect(() => {
    if (
      forceOnboarding ||
      localStorage.getItem(localStorageKey.setupCompleted) === 'true' ||
      !hasPriorAppUse(providers, hasPriorThread)
    ) {
      return
    }
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    window.dispatchEvent(new Event('app:setup-completed'))
  }, [forceOnboarding, hasPriorThread, providers])

  // Shared with the startup auto-start gate so the two can never disagree about
  // onboarding. Also covers the dev-only FORCE_ONBOARDING flag, which enters
  // onboarding despite installed models without blocking the way out.
  const onboardingPending =
    !setupSkippedThisSession &&
    (forceOnboarding || !hasPriorThread) &&
    isOnboardingPending(providers)

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
      // The home composer has no thread yet, so normally there is nothing to
      // browse and only the run settings live in its right column. Attaching a
      // folder before the first message is the exception: that folder already
      // belongs to the chat about to start, so let the sidebar show it.
      filesEnabled={(agentWorkspace?.externalRoots.length ?? 0) > 0}
    >
      <div className="flex h-full w-full min-w-0 flex-col justify-center">
        {/* The model is picked from the composer; the header only frames
            the page. */}
        <HeaderPage />
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
