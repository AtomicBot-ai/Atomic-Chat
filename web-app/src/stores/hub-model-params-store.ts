import { create } from 'zustand'

import { fetchModelParams } from '@/lib/model-card'

/**
 * Hugging Face's parameter count for the Hub rows whose name carries none
 * ("Ling 3.0 flash"), so every row of the local models table, and the row
 * opened from it, names the same count.
 *
 * Asked only for rows on screen, two at a time and never twice: anonymous
 * requests to Hugging Face are rate-limited per IP. The latest ask replaces
 * whatever was still waiting, so rows scrolled past are not asked for.
 */

const CONCURRENCY = 2

type HubModelParamsState = {
  /** Answers by repo id; `null` when Hugging Face reports no count. */
  params: Record<string, string | null>
  /** Ask for these repos, the rows on screen. */
  ensure: (repoIds: readonly string[]) => void
  reset: () => void
}

let waiting: string[] = []
const inFlight = new Set<string>()

export const useHubModelParams = create<HubModelParamsState>()((set, get) => {
  const answer = (repoId: string, params: string | null) => {
    inFlight.delete(repoId)
    set((state) => ({ params: { ...state.params, [repoId]: params } }))
    pump()
  }

  const pump = () => {
    while (inFlight.size < CONCURRENCY && waiting.length > 0) {
      const repoId = waiting.shift()!
      inFlight.add(repoId)
      fetchModelParams(repoId).then(
        (params) => answer(repoId, params ?? null),
        () => answer(repoId, null)
      )
    }
  }

  return {
    params: {},
    ensure: (repoIds) => {
      const { params } = get()
      waiting = [...new Set(repoIds)].filter(
        (id) => !(id in params) && !inFlight.has(id)
      )
      pump()
    },
    reset: () => {
      waiting = []
      inFlight.clear()
      set({ params: {} })
    },
  }
})
