import { create } from 'zustand'

import { TEMPORARY_CHAT_ID } from '@/constants/chat'
import { localStorageKey } from '@/constants/localStorage'

/**
 * The composer's unsent text, kept per composer.
 *
 * `prompt` is the text of the composer the store is bound to, `draftKey` —
 * the key from `lib/composer-thread-key`: a thread id, `project:<id>`, or the
 * home composer's temporary id. Opening another composer (`bindDraft`) parks
 * that text under its key and restores the new composer's own draft, so an
 * unsent draft never follows the user into an unrelated chat. The composer
 * itself reads and writes by its key (`selectDraft`, `setDraft`), so its first
 * render is right before it binds; other readers (the token counter) use
 * `prompt`, the bound composer's text, as one composer is shown at a time.
 *
 * Drafts of saved chats and projects survive a relaunch: every write is
 * stored in localStorage, one item per composer key, and the store starts
 * from what the last session left. The home composer's key is not stored —
 * it is also the temporary chat's id, and a temporary chat keeps nothing on
 * disk. A sent or cleared draft is removed; drafts untouched for
 * `DRAFT_MAX_AGE_MS`, or beyond the newest `DRAFT_MAX_COUNT`, are pruned at
 * launch, and deleting a chat drops its draft (`clearDraft`).
 */
type PromptStoreState = {
  prompt: string
  /** Composer key `prompt` belongs to; null until a composer binds. */
  draftKey: string | null
  /** Unsent text of the composers that are not bound, by composer key. */
  drafts: Record<string, string>
  setPrompt: (value: string) => void
  resetPrompt: () => void
  /** Bind the store to a composer: park the current text, restore `key`'s. */
  bindDraft: (key: string) => void
  /** Any composer's draft, bound or parked. */
  getDraft: (key: string) => string
  /** Write any composer's draft, bound or parked. */
  setDraft: (key: string, value: string) => void
  /** Forget a composer's draft, in memory and on disk (its chat was deleted). */
  clearDraft: (key: string) => void
}

/** A draft nobody has touched for this long is dropped at the next launch. */
export const DRAFT_MAX_AGE_MS = 30 * 24 * 60 * 60 * 1000
/** At most this many drafts are kept across a relaunch, the newest first. */
export const DRAFT_MAX_COUNT = 50

type StoredDraft = { text: string; at: number }

const storageKeyOf = (key: string) =>
  `${localStorageKey.composerDraftPrefix}${key}`

/**
 * Whether `key`'s draft is kept across a relaunch. The home composer shares
 * its key with the temporary chat, whose messages never reach the disk; its
 * draft should not either.
 */
const persists = (key: string) => key !== TEMPORARY_CHAT_ID

/** Keys whose last write did not reach storage (quota): memory is newer. */
const unsavedKeys = new Set<string>()

function parseStoredDraft(raw: string | null): StoredDraft | null {
  if (!raw) return null
  try {
    const value = JSON.parse(raw) as Partial<StoredDraft> | null
    if (
      value &&
      typeof value.text === 'string' &&
      value.text !== '' &&
      typeof value.at === 'number' &&
      Number.isFinite(value.at)
    ) {
      return { text: value.text, at: value.at }
    }
  } catch {
    // Unreadable: treated as no draft, and pruned at the next launch.
  }
  return null
}

/**
 * `key`'s stored draft ('' when none is stored), or undefined when it is not
 * kept on disk, its last write failed, or storage cannot be read — memory
 * holds the newest text then.
 */
function readStoredDraft(key: string): string | undefined {
  if (!persists(key) || unsavedKeys.has(key)) return undefined
  try {
    return parseStoredDraft(localStorage.getItem(storageKeyOf(key)))?.text ?? ''
  } catch {
    return undefined
  }
}

function writeStoredDraft(key: string, text: string): void {
  if (!persists(key)) return
  try {
    if (text) {
      localStorage.setItem(
        storageKeyOf(key),
        JSON.stringify({ text, at: Date.now() } satisfies StoredDraft)
      )
    } else {
      localStorage.removeItem(storageKeyOf(key))
    }
    unsavedKeys.delete(key)
  } catch (error) {
    unsavedKeys.add(key)
    console.warn('[drafts] could not save the unsent draft:', error)
  }
}

/**
 * The drafts the last session left, by composer key. Drafts older than
 * `DRAFT_MAX_AGE_MS`, beyond the newest `DRAFT_MAX_COUNT`, unreadable, or
 * under a key that is not kept are removed from storage on the way.
 */
export function loadStoredDrafts(now = Date.now()): Record<string, string> {
  const prefix = localStorageKey.composerDraftPrefix
  const kept: Array<[string, StoredDraft]> = []
  const dropped: string[] = []
  try {
    for (let index = 0; index < localStorage.length; index++) {
      const storageKey = localStorage.key(index)
      if (!storageKey?.startsWith(prefix)) continue
      const key = storageKey.slice(prefix.length)
      const draft = parseStoredDraft(localStorage.getItem(storageKey))
      if (!draft || !persists(key) || now - draft.at > DRAFT_MAX_AGE_MS) {
        dropped.push(storageKey)
      } else {
        kept.push([key, draft])
      }
    }
    kept.sort((a, b) => b[1].at - a[1].at)
    for (const [key] of kept.splice(DRAFT_MAX_COUNT)) {
      dropped.push(storageKeyOf(key))
    }
    for (const storageKey of dropped) localStorage.removeItem(storageKey)
  } catch (error) {
    console.warn('[drafts] could not read the saved drafts:', error)
  }
  return Object.fromEntries(kept.map(([key, draft]) => [key, draft.text]))
}

/**
 * Selects `key`'s draft, bound or parked. A composer reads through this, so
 * its first render already shows its own text, before `bindDraft` runs.
 * Text typed before any composer bound (a fresh store) belongs to the first
 * composer that binds or writes it.
 */
export const selectDraft =
  (key: string) =>
  (state: Pick<PromptStoreState, 'prompt' | 'draftKey' | 'drafts'>): string => {
    if (state.draftKey === key) return state.prompt
    if (state.draftKey === null && state.prompt) return state.prompt
    return state.drafts[key] ?? ''
  }

const park = (
  drafts: Record<string, string>,
  key: string,
  value: string
): Record<string, string> => {
  const next = { ...drafts }
  if (value) next[key] = value
  else delete next[key]
  return next
}

export const usePrompt = create<PromptStoreState>((set, get) => ({
  prompt: '',
  draftKey: null,
  drafts: loadStoredDrafts(),
  setPrompt: (value) => {
    set({ prompt: value })
    const { draftKey } = get()
    if (draftKey !== null) writeStoredDraft(draftKey, value)
  },
  resetPrompt: () => {
    set({ prompt: '' })
    const { draftKey } = get()
    if (draftKey !== null) writeStoredDraft(draftKey, '')
  },
  bindDraft: (key) =>
    set((state) => {
      if (state.draftKey === key) return state
      const { [key]: parked = '', ...others } = state.drafts
      // What is stored is the newest text for the key: a chat window opened
      // beside this one may have changed or sent it since it was parked here.
      const restored = readStoredDraft(key) ?? parked
      if (state.draftKey === null) {
        return state.prompt
          ? { draftKey: key, drafts: others }
          : { draftKey: key, prompt: restored, drafts: others }
      }
      return {
        draftKey: key,
        prompt: restored,
        drafts: park(others, state.draftKey, state.prompt),
      }
    }),
  getDraft: (key) => selectDraft(key)(get()),
  setDraft: (key, value) => {
    set((state) =>
      state.draftKey === key || state.draftKey === null
        ? { prompt: value, draftKey: key, drafts: park(state.drafts, key, '') }
        : { drafts: park(state.drafts, key, value) }
    )
    writeStoredDraft(key, value)
  },
  clearDraft: (key) => {
    set((state) =>
      state.draftKey === key
        ? { prompt: '' }
        : { drafts: park(state.drafts, key, '') }
    )
    writeStoredDraft(key, '')
  },
}))
