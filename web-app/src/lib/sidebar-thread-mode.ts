/**
 * Sidebar history filters. The chat/agent split is gone — every thread lives
 * in one unified history; only project threads (rendered under their project)
 * and favorites (for bulk delete) are filtered here.
 */
export function filterSidebarHistoryThreads<
  T extends {
    id: string
    isFavorite?: boolean
    metadata?: { project?: unknown }
  },
>(threads: readonly T[]): T[] {
  return threads.filter((thread) => !thread.metadata?.project)
}

export function filterDeletableSidebarHistoryThreads<
  T extends {
    id: string
    isFavorite?: boolean
    metadata?: { project?: unknown }
  },
>(threads: readonly T[]): T[] {
  return filterSidebarHistoryThreads(threads).filter(
    (thread) => !thread.isFavorite
  )
}
