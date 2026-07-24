import type { SidebarMode } from '@/hooks/useAgentMode'

export function isThreadInSidebarMode(
  threadId: string,
  mode: SidebarMode,
  agentThreads: Readonly<Record<string, boolean>>
): boolean {
  return (agentThreads[threadId] === true) === (mode === 'agent')
}

export function filterThreadsBySidebarMode<T extends { id: string }>(
  threads: readonly T[],
  mode: SidebarMode,
  agentThreads: Readonly<Record<string, boolean>>
): T[] {
  return threads.filter((thread) =>
    isThreadInSidebarMode(thread.id, mode, agentThreads)
  )
}

export function filterSidebarHistoryThreads<
  T extends {
    id: string
    isFavorite?: boolean
    metadata?: { project?: unknown }
  },
>(
  threads: readonly T[],
  mode: SidebarMode,
  agentThreads: Readonly<Record<string, boolean>>
): T[] {
  return filterThreadsBySidebarMode(threads, mode, agentThreads).filter(
    (thread) => !thread.metadata?.project
  )
}

export function filterDeletableSidebarHistoryThreads<
  T extends {
    id: string
    isFavorite?: boolean
    metadata?: { project?: unknown }
  },
>(
  threads: readonly T[],
  mode: SidebarMode,
  agentThreads: Readonly<Record<string, boolean>>
): T[] {
  return filterSidebarHistoryThreads(threads, mode, agentThreads).filter(
    (thread) => !thread.isFavorite
  )
}
