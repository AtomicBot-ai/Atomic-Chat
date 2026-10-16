import { describe, expect, it } from 'vitest'
import type { MediaFileSystem } from '../../assets'
import { advanceSchedules, createScheduleStore, nextOccurrence, type MediaSchedule } from '../schedule'
import { createSessionStore } from '../sessionStore'
import { expandSteps } from '../session'

function memoryFs(): MediaFileSystem & { files: Map<string, string> } {
  const files = new Map<string, string>()
  const dirs = new Set<string>()
  return {
    files,
    join: (...p) => p.join('/'),
    mkdir: async (p) => void dirs.add(p),
    exists: async (p) => files.has(p) || dirs.has(p),
    writeBytes: async (p, b) => void files.set(p, new TextDecoder().decode(b)),
    readText: async (p) => files.get(p)!,
    rename: async (a, b) => {
      files.set(b, files.get(a)!)
      files.delete(a)
    },
    remove: async (p) => void files.delete(p),
    size: async (p) => files.get(p)?.length ?? 0,
  }
}

const HOUR = 3_600_000
const base: MediaSchedule = {
  id: 's1', label: 'x', target: { kind: 'session', session_id: 'abc' },
  at: 1000, repeat: 'none', enabled: true, created_at: 0,
}

describe('schedule timing', () => {
  it('one-shots fire once then disable', () => {
    const { due, next } = advanceSchedules([base], 2000)
    expect(due).toHaveLength(1)
    expect(next[0]).toMatchObject({ enabled: false, last_run_at: 2000 })
    expect(advanceSchedules(next, 3000).due).toHaveLength(0)
  })
  it('not yet due does nothing', () => {
    expect(advanceSchedules([base], 999).due).toHaveLength(0)
  })
  it('repeats move to the next future occurrence, firing once for missed intervals', () => {
    const { due, next } = advanceSchedules([{ ...base, repeat: 'hourly' }], 1000 + 5.5 * HOUR)
    expect(due).toHaveLength(1)
    expect(next[0]!.at).toBe(1000 + 6 * HOUR)
    expect(nextOccurrence(1000, 'daily', 0)).toBe(1000)
    expect(nextOccurrence(1000, 'none', 5000)).toBeUndefined()
  })
})

describe('persistence', () => {
  it('schedules survive a "restart" (new store over the same files)', async () => {
    const fs = memoryFs()
    const deps = { fs, dataFolder: async () => '/data' }
    await createScheduleStore(deps).save([base, { ...base, id: 's2', repeat: 'weekly' }])
    expect(fs.files.has('/data/media/continuous/schedules.json')).toBe(true)
    const loaded = await createScheduleStore(deps).load()
    expect(loaded.map((s) => s.id)).toEqual(['s1', 's2'])
  })
  it('drops malformed entries and tolerates a corrupt file', async () => {
    const fs = memoryFs()
    const deps = { fs, dataFolder: async () => '/data' }
    fs.files.set('/data/media/continuous/schedules.json', JSON.stringify({ schedules: [base, { id: 1 }] }))
    expect(await createScheduleStore(deps).load()).toHaveLength(1)
    fs.files.set('/data/media/continuous/schedules.json', '{nope')
    expect(await createScheduleStore(deps).load()).toEqual([])
  })
  it('sessions and plan.md are stored side by side', async () => {
    const fs = memoryFs()
    const store = createSessionStore({ fs, dataFolder: async () => '/d' })
    const segments = [{ id: 'a', prompt: 'p', start: { kind: 'previous' as const }, runs: 2 }]
    await store.save({ id: 'S', name: 'n', created_at: 1, updated_at: 1, segments, steps: expandSteps(segments), status: 'draft', stitch: true }, '## Segment 1\np\n')
    expect(await store.readPlan('S')).toContain('## Segment 1')
    const listed = await createSessionStore({ fs, dataFolder: async () => '/d' }).list()
    expect(listed[0]!.steps).toHaveLength(2)
    await store.remove('S')
    expect(await store.list()).toEqual([])
  })
})
