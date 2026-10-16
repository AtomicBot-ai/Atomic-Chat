/**
 * Start a continuous session (or a single generation) at a set time,
 * optionally repeating.
 *
 * Schedules are persisted to `<data_folder>/media/continuous/schedules.json`
 * so they survive a restart, but they only FIRE WHILE THE APP IS OPEN: there
 * is no OS-level scheduler or background daemon. A schedule whose time passed
 * while the app was closed fires once on the next launch (catch-up); a
 * repeating one then moves to its next future occurrence rather than firing
 * once per missed interval.
 */
import { MEDIA_FOLDER, type MediaFileSystem } from '../assets'
import { readJson, writeTextAtomic } from './jsonFile'

export const SCHEDULES_SCHEMA_VERSION = 1
export const CONTINUOUS_FOLDER = 'continuous'
export const SCHEDULES_FILE = 'schedules.json'

export type ScheduleRepeat = 'none' | 'hourly' | 'daily' | 'weekly'

export type ScheduleTarget =
  | { kind: 'session'; session_id: string }
  | { kind: 'job'; task: 'text_to_image' | 'text_to_video'; prompt: string; length_seconds?: number }

export type MediaSchedule = {
  id: string
  label: string
  target: ScheduleTarget
  /** Next fire time, epoch ms. */
  at: number
  repeat: ScheduleRepeat
  enabled: boolean
  last_run_at?: number
  created_at: number
}

const STEP_MS: Record<Exclude<ScheduleRepeat, 'none'>, number> = {
  hourly: 60 * 60 * 1000,
  daily: 24 * 60 * 60 * 1000,
  weekly: 7 * 24 * 60 * 60 * 1000,
}

/** Next occurrence strictly after `now`, or undefined for a one-shot. */
export function nextOccurrence(at: number, repeat: ScheduleRepeat, now: number): number | undefined {
  if (repeat === 'none') return undefined
  const step = STEP_MS[repeat]
  if (at > now) return at
  const missed = Math.floor((now - at) / step) + 1
  return at + missed * step
}

export function isDue(schedule: MediaSchedule, now: number): boolean {
  return schedule.enabled && schedule.at <= now
}

/**
 * Advance schedules at `now`: returns the ones to fire and the updated list
 * (one-shots disabled, repeats moved to their next future time).
 */
export function advanceSchedules(
  schedules: MediaSchedule[],
  now: number
): { due: MediaSchedule[]; next: MediaSchedule[] } {
  const due: MediaSchedule[] = []
  const next = schedules.map((schedule) => {
    if (!isDue(schedule, now)) return schedule
    due.push(schedule)
    const following = nextOccurrence(schedule.at, schedule.repeat, now)
    return following === undefined
      ? { ...schedule, enabled: false, last_run_at: now }
      : { ...schedule, at: following, last_run_at: now }
  })
  return { due, next }
}

function isSchedule(value: unknown): value is MediaSchedule {
  if (!value || typeof value !== 'object') return false
  const s = value as Partial<MediaSchedule>
  return (
    typeof s.id === 'string' &&
    typeof s.at === 'number' &&
    typeof s.enabled === 'boolean' &&
    !!s.target &&
    (s.target.kind === 'session' || s.target.kind === 'job') &&
    (s.repeat === 'none' || s.repeat === 'hourly' || s.repeat === 'daily' || s.repeat === 'weekly')
  )
}

export type ScheduleStoreDeps = {
  fs: MediaFileSystem
  dataFolder: () => Promise<string>
}

export function createScheduleStore(deps: ScheduleStoreDeps) {
  const path = async () => {
    const folder = deps.fs.join(await deps.dataFolder(), MEDIA_FOLDER, CONTINUOUS_FOLDER)
    if (!(await deps.fs.exists(folder))) await deps.fs.mkdir(folder)
    return deps.fs.join(folder, SCHEDULES_FILE)
  }
  return {
    async load(): Promise<MediaSchedule[]> {
      const data = await readJson<{ schema_version?: number; schedules?: unknown[] }>(deps.fs, await path())
      if (!data || !Array.isArray(data.schedules)) return []
      return data.schedules.filter(isSchedule)
    },
    async save(schedules: MediaSchedule[]): Promise<void> {
      await writeTextAtomic(
        deps.fs,
        await path(),
        JSON.stringify({ schema_version: SCHEDULES_SCHEMA_VERSION, schedules }, null, 2)
      )
    },
  }
}

export type ScheduleStore = ReturnType<typeof createScheduleStore>
