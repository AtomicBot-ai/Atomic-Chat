import { getServiceHub } from '@/hooks/useServiceHub'
import { Assistant as CoreAssistant } from '@janhq/core'
import { create } from 'zustand'
import { localStorageKey } from '@/constants/localStorage'

interface AssistantState {
  assistants: Assistant[]
  currentAssistant: Assistant | null
  defaultAssistantId: string
  /**
   * Assistant chosen for an unsaved (new) chat, shared across the chat input
   * and the model-bar Sampling popover. Bound to the thread on creation, then
   * reset to undefined. `undefined` means "fall back to default/thread".
   */
  pendingAssistant: Assistant | undefined
  setPendingAssistant: (assistant: Assistant | undefined) => void
  addAssistant: (assistant: Assistant) => void
  updateAssistant: (assistant: Assistant) => void
  /**
   * Set a single sampling parameter on one assistant. Applied to the store
   * immediately (sliders stay responsive) and written to disk on a debounce,
   * since a slider drag emits a change per frame.
   */
  updateAssistantParam: (id: string, key: string, value: unknown) => void
  deleteAssistant: (id: string) => void
  setCurrentAssistant: (assistant: Assistant, saveToStorage?: boolean) => void
  setDefaultAssistant: (id: string) => void
  setAssistants: (assistants: Assistant[]) => void
  getLastUsedAssistant: () => string | null
  setLastUsedAssistant: (assistantId: string) => void
  initializeWithLastUsed: () => void
}

// Helper functions for localStorage
const getLastUsedAssistantId = (): string | null => {
  try {
    return localStorage.getItem(localStorageKey.lastUsedAssistant)
  } catch (error) {
    console.debug('Failed to get last used assistant from localStorage:', error)
    return null
  }
}

const setLastUsedAssistantId = (assistantId: string) => {
  try {
    localStorage.setItem(localStorageKey.lastUsedAssistant, assistantId)
  } catch (error) {
    console.debug('Failed to set last used assistant in localStorage:', error)
  }
}

export const defaultAssistant: Assistant = {
  id: 'jan',
  name: 'Atomic Chat',
  created_at: 1747029866.542,
  parameters: {
    temperature: 0.7,
    top_k: 20,
    top_p: 0.8,
    repeat_penalty: 1.12,
  },
  avatar: '/images/transparent-logo.png',
  description:
    "Atomic Chat is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user's behalf.",
  instructions: 'Current date: {{current_date}}',
}

const getDefaultAssistantIdFromStorage = (): string => {
  try {
    const stored = localStorage.getItem(localStorageKey.defaultAssistantId)
    if (stored) return stored
    // First install: persist the built-in default so it's explicit
    localStorage.setItem(
      localStorageKey.defaultAssistantId,
      defaultAssistant.id
    )
    return defaultAssistant.id
  } catch (error) {
    console.debug('Failed to get default assistant from localStorage:', error)
    return defaultAssistant.id
  }
}

const setDefaultAssistantIdToStorage = (assistantId: string) => {
  try {
    localStorage.setItem(localStorageKey.defaultAssistantId, assistantId)
  } catch (error) {
    console.debug('Failed to set default assistant in localStorage:', error)
  }
}

// Platform-aware initial state
const getInitialAssistantState = () => {
  return {
    assistants: [defaultAssistant],
    currentAssistant: defaultAssistant,
    defaultAssistantId: getDefaultAssistantIdFromStorage(),
  }
}

const PARAM_PERSIST_DEBOUNCE_MS = 300
const paramPersistTimers = new Map<string, ReturnType<typeof setTimeout>>()

const schedulePersistParams = (
  id: string,
  resolve: () => Assistant | undefined
) => {
  const scheduled = paramPersistTimers.get(id)
  if (scheduled) clearTimeout(scheduled)
  paramPersistTimers.set(
    id,
    setTimeout(() => {
      paramPersistTimers.delete(id)
      const assistant = resolve()
      if (!assistant) return
      getServiceHub()
        .assistants()
        .createAssistant(assistant as unknown as CoreAssistant)
        .catch((error) => {
          console.error('Failed to persist assistant sampling:', error)
        })
    }, PARAM_PERSIST_DEBOUNCE_MS)
  )
}

export const useAssistant = create<AssistantState>((set, get) => ({
  ...getInitialAssistantState(),
  pendingAssistant: undefined,
  setPendingAssistant: (assistant) => set({ pendingAssistant: assistant }),
  addAssistant: (assistant) => {
    set({ assistants: [...get().assistants, assistant] })
    getServiceHub()
      .assistants()
      .createAssistant(assistant as unknown as CoreAssistant)
      .catch((error) => {
        console.error('Failed to create assistant:', error)
      })
  },
  updateAssistant: (assistant) => {
    const state = get()
    set({
      assistants: state.assistants.map((a) =>
        a.id === assistant.id ? assistant : a
      ),
      // Update currentAssistant if it's the same assistant being updated
      currentAssistant:
        state.currentAssistant?.id === assistant.id
          ? assistant
          : state.currentAssistant,
      pendingAssistant:
        state.pendingAssistant?.id === assistant.id
          ? assistant
          : state.pendingAssistant,
    })
    // Create assistant already cover update logic
    getServiceHub()
      .assistants()
      .createAssistant(assistant as unknown as CoreAssistant)
      .catch((error) => {
        console.error('Failed to update assistant:', error)
      })
  },
  updateAssistantParam: (id, key, value) => {
    const state = get()
    const target = state.assistants.find((a) => a.id === id)
    if (!target) return

    const updated: Assistant = {
      ...target,
      parameters: { ...target.parameters, [key]: value },
      sampling_overridden: true,
    }
    set({
      assistants: state.assistants.map((a) => (a.id === id ? updated : a)),
      currentAssistant:
        state.currentAssistant?.id === id ? updated : state.currentAssistant,
      pendingAssistant:
        state.pendingAssistant?.id === id ? updated : state.pendingAssistant,
    })
    schedulePersistParams(id, () =>
      get().assistants.find((a) => a.id === id)
    )
  },
  deleteAssistant: (id) => {
    const state = get()
    getServiceHub()
      .assistants()
      .deleteAssistant(
        state.assistants.find((e) => e.id === id) as unknown as CoreAssistant
      )
      .catch((error) => {
        console.error('Failed to delete assistant:', error)
      })

    // Check if we're deleting the current or default assistant
    const wasCurrentAssistant = state.currentAssistant?.id === id
    const wasDefaultAssistant = state.defaultAssistantId === id

    set({ assistants: state.assistants.filter((a) => a.id !== id) })

    // If the deleted assistant was current, fallback to default and update localStorage
    if (wasCurrentAssistant) {
      set({ currentAssistant: defaultAssistant })
      setLastUsedAssistantId(defaultAssistant.id)
    }

    // If the deleted assistant was the default, reset to the built-in default
    if (wasDefaultAssistant) {
      set({ defaultAssistantId: defaultAssistant.id })
      setDefaultAssistantIdToStorage(defaultAssistant.id)
    }
  },
  setDefaultAssistant: (id) => {
    set({ defaultAssistantId: id })
    setDefaultAssistantIdToStorage(id)
  },
  setCurrentAssistant: (assistant, saveToStorage = true) => {
    if (assistant !== get().currentAssistant) {
      set({ currentAssistant: assistant })
      if (saveToStorage) {
        setLastUsedAssistantId(assistant.id)
      }
    }
  },
  setAssistants: (assistants) => {
    set({ assistants })
  },
  getLastUsedAssistant: () => {
    return getLastUsedAssistantId()
  },
  setLastUsedAssistant: (assistantId) => {
    setLastUsedAssistantId(assistantId)
  },
  initializeWithLastUsed: () => {
    const lastUsedId = getLastUsedAssistantId()
    if (lastUsedId) {
      const lastUsedAssistant = get().assistants.find(
        (a) => a.id === lastUsedId
      )
      if (lastUsedAssistant) {
        set({ currentAssistant: lastUsedAssistant })
      } else {
        // Fallback to default if last used assistant was deleted
        set({ currentAssistant: defaultAssistant })
        setLastUsedAssistantId(defaultAssistant.id)
      }
    }
  },
}))
