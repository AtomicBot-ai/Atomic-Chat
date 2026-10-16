/**
 * On-disk sessions: `<data_folder>/media/continuous/sessions/<id>/session.json`
 * plus the editable `plan.md` beside it. An index file lists the ids, because
 * the media filesystem seam deliberately has no directory listing.
 */
import { MEDIA_FOLDER, type MediaFileSystem } from '../assets'
import { readJson, writeTextAtomic } from './jsonFile'
import { CONTINUOUS_FOLDER } from './schedule'
import type { ContinuousSession } from './session'

export const SESSIONS_FOLDER = 'sessions'
export const SESSIONS_INDEX = 'sessions.json'

export type SessionStoreDeps = { fs: MediaFileSystem; dataFolder: () => Promise<string> }

export function createSessionStore(deps: SessionStoreDeps) {
  const { fs } = deps
  const ensure = async (path: string) => {
    if (!(await fs.exists(path))) await fs.mkdir(path)
    return path
  }
  const root = async () => {
    const media = await ensure(fs.join(await deps.dataFolder(), MEDIA_FOLDER))
    return ensure(fs.join(media, CONTINUOUS_FOLDER))
  }
  const dirOf = async (id: string) => {
    const sessions = await ensure(fs.join(await root(), SESSIONS_FOLDER))
    return ensure(fs.join(sessions, id))
  }
  const readIndex = async () =>
    (await readJson<{ ids?: string[] }>(fs, fs.join(await root(), SESSIONS_INDEX)))?.ids ?? []

  return {
    dirOf,
    async list(): Promise<ContinuousSession[]> {
      const out: ContinuousSession[] = []
      for (const id of await readIndex()) {
        const session = await readJson<ContinuousSession>(fs, fs.join(await dirOf(id), 'session.json'))
        if (session && Array.isArray(session.steps)) out.push(session)
      }
      return out.sort((a, b) => b.created_at - a.created_at)
    },
    async save(session: ContinuousSession, planMarkdown?: string): Promise<void> {
      const dir = await dirOf(session.id)
      await writeTextAtomic(fs, fs.join(dir, 'session.json'), JSON.stringify(session, null, 2))
      if (planMarkdown !== undefined) await writeTextAtomic(fs, fs.join(dir, 'plan.md'), planMarkdown)
      const ids = await readIndex()
      if (!ids.includes(session.id)) {
        await writeTextAtomic(fs, fs.join(await root(), SESSIONS_INDEX), JSON.stringify({ ids: [...ids, session.id] }))
      }
    },
    async readPlan(id: string): Promise<string | undefined> {
      const path = fs.join(await dirOf(id), 'plan.md')
      return (await fs.exists(path)) ? fs.readText(path) : undefined
    },
    async remove(id: string): Promise<void> {
      // Only the index entry: clips live in the library and are never deleted here.
      const ids = (await readIndex()).filter((entry) => entry !== id)
      await writeTextAtomic(fs, fs.join(await root(), SESSIONS_INDEX), JSON.stringify({ ids }))
    },
  }
}

export type SessionStore = ReturnType<typeof createSessionStore>
