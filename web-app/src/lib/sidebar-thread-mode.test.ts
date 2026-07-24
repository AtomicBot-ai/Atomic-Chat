import { describe, expect, it } from 'vitest'
import {
  filterDeletableSidebarHistoryThreads,
  filterSidebarHistoryThreads,
  filterThreadsBySidebarMode,
  isThreadInSidebarMode,
} from './sidebar-thread-mode'

const agentThreads = { agent: true }
const threads = [{ id: 'chat' }, { id: 'agent' }]

describe('sidebar thread mode', () => {
  it('classifies unmarked threads as Chat and marked threads as Agent', () => {
    expect(isThreadInSidebarMode('chat', 'chat', agentThreads)).toBe(true)
    expect(isThreadInSidebarMode('chat', 'agent', agentThreads)).toBe(false)
    expect(isThreadInSidebarMode('agent', 'agent', agentThreads)).toBe(true)
    expect(isThreadInSidebarMode('agent', 'chat', agentThreads)).toBe(false)
  })

  it('returns only threads from the requested mode', () => {
    expect(filterThreadsBySidebarMode(threads, 'chat', agentThreads)).toEqual([
      { id: 'chat' },
    ])
    expect(filterThreadsBySidebarMode(threads, 'agent', agentThreads)).toEqual([
      { id: 'agent' },
    ])
  })

  it('keeps project threads out of sidebar histories', () => {
    const projectChat = { id: 'project-chat', metadata: { project: 'p1' } }

    expect(
      filterSidebarHistoryThreads(
        [...threads, projectChat],
        'chat',
        agentThreads
      )
    ).toEqual([{ id: 'chat' }])
  })

  it('limits bulk deletion to non-favorite threads in the active mode', () => {
    const scopedThreads = [
      ...threads,
      { id: 'favorite-chat', isFavorite: true },
      { id: 'project-chat', metadata: { project: 'p1' } },
    ]

    expect(
      filterDeletableSidebarHistoryThreads(scopedThreads, 'chat', agentThreads)
    ).toEqual([{ id: 'chat' }])
    expect(
      filterDeletableSidebarHistoryThreads(scopedThreads, 'agent', agentThreads)
    ).toEqual([{ id: 'agent' }])
  })
})
