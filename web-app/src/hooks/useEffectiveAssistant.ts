import { useCallback, useMemo } from 'react'

import { useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'

/**
 * The assistant whose persona and sampling the current chat uses, always as
 * the live store record so edits made through `updateParam` are what the next
 * request sends. Priority mirrors `resolveAssistantForThread`: thread-bound ->
 * unsaved-chat selection -> default -> first.
 */
export function useEffectiveAssistant() {
  const assistants = useAssistant((state) => state.assistants)
  const defaultAssistantId = useAssistant((state) => state.defaultAssistantId)
  const pendingAssistant = useAssistant((state) => state.pendingAssistant)
  const setPendingAssistant = useAssistant((state) => state.setPendingAssistant)
  const updateAssistantParam = useAssistant(
    (state) => state.updateAssistantParam
  )

  const currentThreadId = useThreads((state) => state.currentThreadId)
  const threadAssistantId = useThreads((state) =>
    currentThreadId
      ? state.threads[currentThreadId]?.assistants?.[0]?.id
      : undefined
  )
  const updateCurrentThreadAssistant = useThreads(
    (state) => state.updateCurrentThreadAssistant
  )

  const activeAssistant = useMemo<Assistant | undefined>(
    () =>
      assistants.find((a) => a.id === threadAssistantId) ??
      assistants.find((a) => a.id === pendingAssistant?.id) ??
      assistants.find((a) => a.id === defaultAssistantId) ??
      assistants[0],
    [assistants, threadAssistantId, pendingAssistant, defaultAssistantId]
  )

  const selectAssistant = useCallback(
    (assistant: Assistant | undefined) => {
      setPendingAssistant(assistant)
      if (currentThreadId) {
        updateCurrentThreadAssistant(assistant as unknown as Assistant)
      }
    },
    [currentThreadId, setPendingAssistant, updateCurrentThreadAssistant]
  )

  const updateParam = useCallback(
    (key: string, value: number | boolean) => {
      if (!activeAssistant) return
      updateAssistantParam(activeAssistant.id, key, value)
    },
    [activeAssistant, updateAssistantParam]
  )

  return { assistants, activeAssistant, selectAssistant, updateParam }
}
