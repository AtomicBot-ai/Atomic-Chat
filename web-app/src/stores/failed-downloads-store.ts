import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type FailedDownload = {
  modelId: string
  repo: string
  isMlx: boolean
  failedAt: number
}
export const RECENT_FAILURE_WINDOW = 30 * 24 * 60 * 60 * 1000
const isRepo = (repo: string) =>
  /^[a-zA-Z0-9][a-zA-Z0-9._-]*\/[a-zA-Z0-9][a-zA-Z0-9._-]*$/.test(repo)

export function recentFailedDownloads(
  entries: readonly FailedDownload[],
  now = Date.now()
) {
  return entries
    .filter(
      (entry) =>
        isRepo(entry.repo) &&
        Number.isFinite(entry.failedAt) &&
        entry.failedAt <= now &&
        now - entry.failedAt < RECENT_FAILURE_WINDOW
    )
    .slice(0, 20)
}

type State = {
  failures: FailedDownload[]
  record: (modelId: string, repo: string, isMlx: boolean) => void
  clear: (modelId: string) => void
}

/** Local recovery metadata only: no tokens, paths, URLs, or error payloads. */
export const useFailedDownloadsStore = create<State>()(
  persist(
    (set) => ({
      failures: [],
      record: (modelId, repo, isMlx) => {
        if (!isRepo(repo) || !/^[a-zA-Z0-9][a-zA-Z0-9._/-]*$/.test(modelId))
          return
        set((state) => ({
          failures: recentFailedDownloads([
            { modelId, repo, isMlx, failedAt: Date.now() },
            ...state.failures.filter((entry) => entry.modelId !== modelId),
          ]),
        }))
      },
      clear: (modelId) =>
        set((state) => ({
          failures: state.failures.filter((entry) => entry.modelId !== modelId),
        })),
    }),
    {
      name: 'atomic-recent-failed-downloads',
      partialize: (state) => ({ failures: state.failures }),
    }
  )
)
