import { describe, expect, it } from 'vitest'
import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import {
  collidingRowIds,
  collidingThreadIds,
  formatRowActivity,
  rowNameKey,
} from '../sidebar-row-names'

const thread = (id: string, title: string): Thread => ({
  id,
  title,
  updated: 0,
})

describe('rowNameKey', () => {
  it('compares the start of a name, ignoring case, spacing and highlights', () => {
    expect(
      rowNameKey('  Generate   a <span class="hl">BLANK</span> page')
    ).toBe('generate a blank')
    expect(rowNameKey('generate a blank html page')).toBe(
      rowNameKey('Generate a blank page for my site')
    )
    expect(rowNameKey('Hi')).toBe('hi')
  })
})

describe('collidingRowIds', () => {
  it('marks every row whose name starts like another row’s, and no other', () => {
    const rows = [
      { id: 'a', name: 'generate a blank html page' },
      { id: 'b', name: 'generate a blank page for my landing site' },
      { id: 'c', name: 'build me a html calculator' },
      { id: 'd', name: 'build me a html snake game' },
      { id: 'e', name: 'build me a site' },
      { id: 'f', name: 'Hi' },
      { id: 'g', name: 'hi' },
    ]
    const ids = collidingRowIds(
      rows,
      (row) => row.id,
      (row) => row.name
    )
    expect([...ids].sort()).toEqual(['a', 'b', 'c', 'd', 'f', 'g'])
  })
})

describe('collidingThreadIds', () => {
  it('counts every chat but the temporary one, and caches per snapshot', () => {
    const threads = {
      one: thread('one', 'Same title'),
      two: thread('two', 'Same title'),
      [TEMPORARY_CHAT_ID]: thread(TEMPORARY_CHAT_ID, 'Unique title here'),
      three: thread('three', 'Unique title here'),
    }
    const ids = collidingThreadIds(threads)
    expect([...ids].sort()).toEqual(['one', 'two'])
    expect(collidingThreadIds(threads)).toBe(ids)
    // Untitled chats all read "New Thread", so they collide too.
    expect(
      [...collidingThreadIds({ x: thread('x', ''), y: thread('y', '') })].sort()
    ).toEqual(['x', 'y'])
  })
})

describe('formatRowActivity', () => {
  const now = new Date(2026, 9, 22, 18, 30).getTime()

  it('gives the time today, the day this year and the date before', () => {
    expect(
      formatRowActivity(new Date(2026, 9, 22, 14, 5).getTime(), 'en-US', now)
        .short
    ).toMatch(/^2:05\sPM$/)
    expect(
      formatRowActivity(new Date(2026, 9, 3, 9, 0).getTime(), 'en-US', now)
        .short
    ).toBe('Oct 3')
    expect(
      formatRowActivity(new Date(2025, 9, 3, 9, 0).getTime(), 'en-US', now)
        .short
    ).toBe('10/3/25')
  })

  it('reads the app’s `vn` as Vietnamese', () => {
    const at = new Date(2026, 9, 3, 9, 0).getTime()
    const vn = formatRowActivity(at, 'vn', now)
    expect(vn).toEqual(formatRowActivity(at, 'vi', now))
    expect(vn.short).not.toBe(formatRowActivity(at, 'en-US', now).short)
  })

  it('writes the full date and time in the app’s language', () => {
    const at = new Date(2026, 9, 3, 9, 0).getTime()
    const { full, iso } = formatRowActivity(at, 'ru', now)
    expect(full).toContain('2026')
    expect(full).toContain('09:00')
    expect(iso).toBe(new Date(at).toISOString())
  })
})
