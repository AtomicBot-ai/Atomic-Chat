import { localStorageKey } from '@/constants/localStorage'
import { defaultAssistant, useAssistant } from '@/hooks/useAssistant'
import { useThreads } from '@/hooks/useThreads'

/**
 * Sampling parameters are per-assistant: every assistant owns its own bag in
 * `assistant.parameters`, persisted to `assistants/{id}/assistant.json`.
 * Resolving them for a chat therefore means finding which assistant that chat
 * is talking to, and reading the *live* store record for it — thread storage
 * only keeps an id/name/instructions snapshot, and the popover may have
 * changed the values since the thread was created.
 */
export interface ResolvedSamplingParams {
  params: Record<string, unknown>
  /** Whether the user tuned this assistant's sampling (see `withRecommendedSampling`). */
  overridden: boolean
  /** undefined when no assistant is bound — the built-in defaults are used. */
  assistantId?: string
}

/**
 * Assistant driving the given chat. Mirrors the Sampling popover's own
 * resolution order: thread-bound -> selection for an unsaved chat -> default
 * -> first available.
 */
export function resolveAssistantForThread(
  threadId?: string
): Assistant | undefined {
  const { assistants, pendingAssistant, defaultAssistantId } =
    useAssistant.getState()

  const threadAssistantId = threadId
    ? useThreads.getState().threads[threadId]?.assistants?.[0]?.id
    : undefined
  const threadAssistant = threadAssistantId
    ? assistants.find((a) => a.id === threadAssistantId)
    : undefined

  return (
    threadAssistant ??
    (pendingAssistant
      ? assistants.find((a) => a.id === pendingAssistant.id)
      : undefined) ??
    assistants.find((a) => a.id === defaultAssistantId) ??
    assistants[0]
  )
}

export function getSamplingParamsForThread(
  threadId?: string
): ResolvedSamplingParams {
  const assistant = resolveAssistantForThread(threadId)
  if (!assistant) {
    return {
      params: { ...(defaultAssistant.parameters ?? {}) },
      overridden: false,
    }
  }

  return {
    params: assistant.parameters ?? {},
    overridden: assistant.sampling_overridden === true,
    assistantId: assistant.id,
  }
}

const readGlobalSampling = ():
  | { params: Record<string, unknown>; userOverridden: boolean }
  | undefined => {
  try {
    const raw = localStorage.getItem(localStorageKey.samplingSettings)
    if (!raw) return undefined
    const parsed = JSON.parse(raw) as {
      state?: { params?: Record<string, unknown>; userOverridden?: boolean }
    }
    const params = parsed.state?.params
    if (!params || Object.keys(params).length === 0) return undefined
    return { params, userOverridden: parsed.state?.userOverridden === true }
  } catch (error) {
    console.debug('Failed to read stored global sampling:', error)
    return undefined
  }
}

/**
 * One-time move of the former app-wide sampling bag onto the assistants that
 * carry no sampling of their own. Assistants that kept parameters from before
 * sampling went global are left untouched, so a tuned persona never loses its
 * values. The `sampling-settings` entry itself stays on disk for rollback.
 *
 * Returns the assistants to use plus the subset that changed and therefore
 * needs persisting.
 */
export function migrateGlobalSamplingToAssistants(assistants: Assistant[]): {
  assistants: Assistant[]
  changed: Assistant[]
} {
  const unchanged = { assistants, changed: [] as Assistant[] }
  let alreadyMigrated = false
  try {
    alreadyMigrated =
      localStorage.getItem(localStorageKey.samplingMigratedPerAssistant) ===
      'true'
  } catch (error) {
    console.debug('Failed to read sampling migration flag:', error)
    return unchanged
  }
  if (alreadyMigrated) return unchanged

  const markDone = () => {
    try {
      localStorage.setItem(
        localStorageKey.samplingMigratedPerAssistant,
        'true'
      )
    } catch (error) {
      console.debug('Failed to set sampling migration flag:', error)
    }
  }

  const global = readGlobalSampling()
  if (!global) {
    markDone()
    return unchanged
  }

  const changed: Assistant[] = []
  const next = assistants.map((assistant) => {
    if (Object.keys(assistant.parameters ?? {}).length > 0) return assistant
    const migratedAssistant: Assistant = {
      ...assistant,
      parameters: { ...global.params },
      sampling_overridden: global.userOverridden,
    }
    changed.push(migratedAssistant)
    return migratedAssistant
  })

  markDone()
  return { assistants: next, changed }
}
