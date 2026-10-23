import { create } from 'zustand'

/**
 * Project uploads that are still being ingested, kept outside the Files
 * section so leaving the project page does not forget them (AC-09).
 *
 * The first upload in an install downloads the embedding model before it
 * indexes anything, which takes minutes. The ingest promise outlives the page,
 * but its "indexing" flag and the list refresh it ends with lived in the
 * component: coming back showed no indicator, and the refresh landed on the
 * unmounted copy, so Files stayed empty until the next visit.
 */
type ProjectUploadState = {
  /** Project id → paths whose ingest has not settled yet. */
  inFlight: Record<string, string[]>
  /** Project id → bumped whenever an ingest adds files; the Files list reloads on it. */
  revision: Record<string, number>
  begin: (projectId: string, paths: string[]) => void
  /** Settle `paths`; `indexed` says whether any file made it into the project. */
  finish: (projectId: string, paths: string[], indexed: boolean) => void
}

export const useProjectUploads = create<ProjectUploadState>()((set) => ({
  inFlight: {},
  revision: {},

  begin: (projectId, paths) =>
    set((state) => ({
      inFlight: {
        ...state.inFlight,
        [projectId]: [...(state.inFlight[projectId] ?? []), ...paths],
      },
    })),

  finish: (projectId, paths, indexed) =>
    set((state) => {
      const settled = new Set(paths)
      const remaining = (state.inFlight[projectId] ?? []).filter(
        (path) => !settled.has(path)
      )
      const inFlight = { ...state.inFlight }
      if (remaining.length > 0) inFlight[projectId] = remaining
      else delete inFlight[projectId]
      return {
        inFlight,
        revision: indexed
          ? {
              ...state.revision,
              [projectId]: (state.revision[projectId] ?? 0) + 1,
            }
          : state.revision,
      }
    }),
}))
