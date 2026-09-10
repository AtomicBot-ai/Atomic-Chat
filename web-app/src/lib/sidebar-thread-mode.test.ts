import { describe, expect, it } from 'vitest'
import {
  filterDeletableSidebarHistoryThreads,
  filterSidebarHistoryThreads,
} from './sidebar-thread-mode'

const threads = [{ id: 'one' }, { id: 'two' }]

describe('sidebar thread mode', () => {
  it('keeps every non-project thread in the unified history', () => {
    const projectThread = { id: 'project-chat', metadata: { project: 'p1' } }

    expect(filterSidebarHistoryThreads([...threads, projectThread])).toEqual(
      threads
    )
  })

  it('limits bulk deletion to non-favorite, non-project threads', () => {
    const scopedThreads = [
      ...threads,
      { id: 'favorite', isFavorite: true },
      { id: 'project-chat', metadata: { project: 'p1' } },
    ]

    expect(filterDeletableSidebarHistoryThreads(scopedThreads)).toEqual(threads)
  })
})
