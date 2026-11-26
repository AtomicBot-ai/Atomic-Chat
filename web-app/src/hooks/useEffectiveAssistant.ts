import { useCallback, useMemo } from 'react'

import { useAssistant } from '@/hooks/useAssistant'
import { resolveAssistantSelection } from '@/lib/samplingParams'
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
  const updateAssistantInstructions = useAssistant(
    (state) => state.updateAssistantInstructions
  )

  const currentThreadId = useThreads((state) => state.currentThreadId)
  const boundAssistants = useThreads((state) =>
    currentThreadId ? state.threads[currentThreadId]?.assistants : undefined
  )
  const updateCurrentThreadAssistant = useThreads(
    (state) => state.updateCurrentThreadAssistant
  )

  const activeAssistant = useMemo<Assistant | undefined>(
    () =>
      resolveAssistantSelection(
        assistants,
        pendingAssistant,
        defaultAssistantId,
        boundAssistants
      ),
    [assistants, boundAssistants, pendingAssistant, defaultAssistantId]
  )

  const selectAssistant = useCallback(
    (assistant: Assistant | undefined) => {
      if (currentThreadId) {
        updateCurrentThreadAssistant(assistant)
      } else {
        setPendingAssistant(assistant ?? null)
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

  const updateInstructions = useCallback(
    (instructions: string) => {
      if (!activeAssistant) return
      updateAssistantInstructions(activeAssistant.id, instructions)
    },
    [activeAssistant, updateAssistantInstructions]
  )

  return {
    assistants,
    activeAssistant,
    selectAssistant,
    updateParam,
    updateInstructions,
  }
}
