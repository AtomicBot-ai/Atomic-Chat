import type { ChatMode } from './pi/navigation'

export function filterSidebarHistoryThreads<
  T extends {
    id: string
    isFavorite?: boolean
    metadata?: { project?: unknown; kind?: unknown }
  },
>(threads: readonly T[], mode: ChatMode = 'chat'): T[] {
  return threads.filter(
    (thread) =>
      !thread.metadata?.project &&
      (thread.metadata?.kind === 'agent') === (mode === 'agent')
  )
}

export function filterDeletableSidebarHistoryThreads<
  T extends {
    id: string
    isFavorite?: boolean
    metadata?: { project?: unknown; kind?: unknown }
  },
>(threads: readonly T[], mode: ChatMode = 'chat'): T[] {
  return filterSidebarHistoryThreads(threads, mode).filter(
    (thread) => !thread.isFavorite
  )
}
