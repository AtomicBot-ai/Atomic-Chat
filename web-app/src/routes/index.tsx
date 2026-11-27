/* eslint-disable @typescript-eslint/no-explicit-any */
import { createFileRoute, Navigate, useSearch } from '@tanstack/react-router'
import ChatInput from '@/containers/ChatInput'
import { ConversationHome } from '@/components/ConversationHome'
import { useTools } from '@/hooks/useTools'

import { useModelProvider } from '@/hooks/useModelProvider'
import { route } from '@/constants/routes'
import {
  hasPriorAppUse,
  shouldEnterOnboarding,
  skipsOnboarding,
} from '@/lib/onboarding'
import { localStorageKey } from '@/constants/localStorage'
import { useSetupCompleted } from '@/hooks/useSetupCompleted'
import { useEffect } from 'react'
import { useThreads } from '@/hooks/useThreads'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

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
  const { providers } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const agentSkill = search.agentSkill
  const { setCurrentThreadId, threads } = useThreads()
  useTools()

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
  //
  // An install whose variant has no setup screen (`none`) is done with setup
  // on arrival: the update banners, the backend progress and the load
  // snackbar that wait for the flag are part of its first run.
  useEffect(() => {
    if (localStorage.getItem(localStorageKey.setupCompleted) === 'true') return
    if (
      !skipsOnboarding() &&
      (forceOnboarding || !hasPriorAppUse(providers, hasPriorThread))
    ) {
      return
    }
    localStorage.setItem(localStorageKey.setupCompleted, 'true')
    window.dispatchEvent(new Event('app:setup-completed'))
  }, [forceOnboarding, hasPriorThread, providers])

  // Leaving the setup screen persists the flag and fires the same-tab event;
  // subscribing keeps this route from sending the user back to it.
  const setupCompleted = useSetupCompleted()

  // Shared with the startup auto-start gate so the two can never disagree about
  // onboarding. A run left on screen at the last close resumes. Also covers
  // the dev-only FORCE_ONBOARDING flag, which enters onboarding despite
  // installed models without blocking the way out.
  const enterOnboarding = shouldEnterOnboarding({
    providers,
    hasPriorThread,
    setupCompleted,
    force: forceOnboarding,
  })

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  if (enterOnboarding) {
    return <Navigate to={route.onboarding} replace />
  }

  return (
    <ConversationHome workspaceKey={TEMPORARY_CHAT_ID}>
      <ChatInput
        showSpeedToken={false}
        model={threadModel}
        initialMessage
        preselectedAgentSkillName={agentSkill}
      />
    </ConversationHome>
  )
}
