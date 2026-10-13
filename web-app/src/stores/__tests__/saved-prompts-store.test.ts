import { beforeEach, describe, expect, it } from 'vitest'

import { STARTER_PROMPTS, useSavedPrompts } from '../saved-prompts-store'
import { overallDownloadProgress, useDownloadDrawer } from '../download-drawer-store'
import { promptVariables } from '@/lib/promptVariables'

describe('saved prompts', () => {
  beforeEach(() => useSavedPrompts.setState({ prompts: STARTER_PROMPTS }))

  it('ships agent starters such as PR triage and performance checks', () => {
    const titles = useSavedPrompts.getState().prompts.map((p) => p.title)
    expect(titles).toEqual(
      expect.arrayContaining(['PR triage', 'GitHub performance check'])
    )
    expect(
      useSavedPrompts.getState().prompts.some((p) => p.category === 'chat')
    ).toBe(true)
  })

  it('adds, edits, duplicates and removes', () => {
    const { add, update, duplicate, remove } = useSavedPrompts.getState()
    const id = add({ title: 'Mine' })
    update(id, { body: 'Do {{thing}}' })
    const copy = duplicate(id)!
    const find = (x: string) => useSavedPrompts.getState().prompts.find((p) => p.id === x)
    expect(find(id)?.body).toBe('Do {{thing}}')
    expect(find(copy)?.title).toBe('Mine (copy)')
    remove(id)
    expect(find(id)).toBeUndefined()
    expect(find(copy)).toBeDefined()
  })

  it('restores starters without touching what the user added', () => {
    const { add, remove, restoreStarters } = useSavedPrompts.getState()
    add({ title: 'Keep me' })
    remove('starter-pr-triage')
    restoreStarters()
    const titles = useSavedPrompts.getState().prompts.map((p) => p.title)
    expect(titles).toContain('PR triage')
    expect(titles).toContain('Keep me')
  })

  it('finds each variable once', () => {
    expect(promptVariables('Check {{repo}} and {{ repo }} then {{branch}}')).toEqual(['repo', 'branch'])
  })
})

describe('download drawer store', () => {
  beforeEach(() => useDownloadDrawer.setState({ items: [], open: false }))
  const row = (id: string, current: number, total: number) => ({ id, progress: total ? current / total : 0, current, total })

  it('opens when the first download starts and closes when the queue empties', () => {
    useDownloadDrawer.getState().setItems([row('a', 1, 10)])
    expect(useDownloadDrawer.getState().open).toBe(true)
    useDownloadDrawer.getState().setOpen(false)
    useDownloadDrawer.getState().setItems([row('a', 2, 10), row('b', 0, 10)])
    expect(useDownloadDrawer.getState().open).toBe(false)
    useDownloadDrawer.getState().setItems([])
    expect(useDownloadDrawer.getState().open).toBe(false)
  })

  it('weights overall progress by size and ignores unknown sizes', () => {
    expect(overallDownloadProgress([row('a', 5, 10), row('b', 0, 30), row('c', 9, 0)])).toBeCloseTo(0.125)
    expect(overallDownloadProgress([])).toBe(0)
  })
})
