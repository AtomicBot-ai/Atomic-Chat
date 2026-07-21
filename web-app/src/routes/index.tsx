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
import { hasValidProviders } from '@/lib/onboarding'
import { localStorageKey } from '@/constants/localStorage'
import { useCallback, useEffect, useState } from 'react'
import { useThreads } from '@/hooks/useThreads'
import DropdownModelProvider from '@/containers/DropdownModelProvider'
import { useAgentMode } from '@/hooks/useAgentMode'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { usePrompt } from '@/hooks/usePrompt'
import { AgentTaskSuggestions } from '@/containers/AgentTaskSuggestions'

type ThreadModel = {
  id: string
  provider: string
}

type SearchParams = {
  threadModel?: ThreadModel
}

export const Route = createFileRoute(route.home as any)({
  component: Index,
  validateSearch: (search: Record<string, unknown>): SearchParams => {
    const result: SearchParams = {
      threadModel: search.threadModel as ThreadModel | undefined,
    }

    return result
  },
})

function Index() {
  const { t } = useTranslation()
  const { providers, selectedProvider } = useModelProvider()
  const search = useSearch({ from: route.home as any })
  const threadModel = search.threadModel
  const { setCurrentThreadId } = useThreads()
  const isAgentMode = useAgentMode(
    (state) => state.agentThreads[TEMPORARY_CHAT_ID] === true
  )
  const sidebarMode = useAgentMode((state) => state.sidebarMode)
  const setAgentMode = useAgentMode((state) => state.setAgentMode)
  const setSidebarMode = useAgentMode((state) => state.setSidebarMode)
  const setPrompt = usePrompt((state) => state.setPrompt)
  useTools()

  const handleSelectAgentTask = useCallback(
    (prompt: string) => {
      setPrompt(prompt)
      document
        .querySelector<HTMLTextAreaElement>('[data-testid="chat-input"]')
        ?.focus()
    },
    [setPrompt]
  )

  //* После Skip без перемонтирования роутера — поднимаем флаг, иначе ре-рендер не гарантирован
  const [setupSkippedThisSession, setSetupSkippedThisSession] = useState(false)
  const setupCompletedOrSkipped =
    setupSkippedThisSession ||
    (typeof window !== 'undefined' &&
      localStorage.getItem(localStorageKey.setupCompleted) === 'true')

  // Conditional to check if there are any valid providers: min 1 api_key or 1
  // model in llama.cpp / jan, or a custom provider with models. Shared with the
  // startup auto-start gate so the two can never disagree about onboarding.
  const validProviders = hasValidProviders(providers)

  useEffect(() => {
    setCurrentThreadId(undefined)
  }, [setCurrentThreadId])

  useEffect(() => {
    const nextMode =
      sidebarMode === 'agent' && selectedProvider === 'mlx'
        ? 'chat'
        : sidebarMode
    if (nextMode !== sidebarMode) setSidebarMode(nextMode)
    setAgentMode(TEMPORARY_CHAT_ID, nextMode === 'agent')
  }, [selectedProvider, setAgentMode, setSidebarMode, sidebarMode])

  //* Dev-флаг FORCE_ONBOARDING — принудительный показ SetupScreen без удаления моделей
  if (FORCE_ONBOARDING || (!validProviders && !setupCompletedOrSkipped)) {
    return <SetupScreen onSkipped={() => setSetupSkippedThisSession(true)} />
  }

  return (
    <div className="flex h-full flex-col justify-center">
      <HeaderPage>
        <div className="flex items-center gap-2 w-full">
          <DropdownModelProvider />
        </div>
      </HeaderPage>
      <div
        className={cn(
          'h-full overflow-y-auto inline-flex flex-col gap-2 justify-center px-3'
        )}
      >
        <div className={cn('relative mx-auto w-full md:w-4/5 xl:w-4/6 -mt-20')}>
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
            />
          </div>
          <div className="absolute inset-x-0 top-full pt-4">
            <AgentTaskSuggestions
              visible={isAgentMode}
              onSelect={handleSelectAgentTask}
            />
          </div>
        </div>
      </div>
    </div>
  )
}
