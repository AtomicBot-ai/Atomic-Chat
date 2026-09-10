import { describe, expect, it } from 'vitest'
import { composerThreadKey } from '@/lib/composer-thread-key'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'

describe('composerThreadKey', () => {
  it('uses the current thread id inside a thread', () => {
    expect(
      composerThreadKey({ isComposer: false, currentThreadId: 'thread-1' })
    ).toBe('thread-1')
  })

  it('falls back to the temporary id when no thread exists', () => {
    expect(composerThreadKey({ isComposer: false })).toBe(TEMPORARY_CHAT_ID)
  })

  it('keys the home composer on the temporary id', () => {
    expect(composerThreadKey({ isComposer: true })).toBe(TEMPORARY_CHAT_ID)
  })

  it('gives each project composer its own slot', () => {
    expect(composerThreadKey({ isComposer: true, projectId: 'p1' })).toBe(
      'project:p1'
    )
    expect(composerThreadKey({ isComposer: true, projectId: 'p2' })).toBe(
      'project:p2'
    )
  })

  it('ignores a stale currentThreadId on a composer page', () => {
    expect(
      composerThreadKey({
        isComposer: true,
        currentThreadId: 'thread-1',
        projectId: 'p1',
      })
    ).toBe('project:p1')
  })
})
