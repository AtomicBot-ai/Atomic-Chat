import { create } from 'zustand'

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
 * Drafts live in memory only: a fresh app session starts empty.
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
}

// Text nobody has bound yet (a fresh store) belongs to the first composer
// that binds or writes it.
const owns = (draftKey: string | null, key: string) =>
  draftKey === null || draftKey === key

/**
 * Selects `key`'s draft, bound or parked. A composer reads through this, so
 * its first render already shows its own text, before `bindDraft` runs.
 */
export const selectDraft =
  (key: string) =>
  (state: Pick<PromptStoreState, 'prompt' | 'draftKey' | 'drafts'>): string =>
    owns(state.draftKey, key) ? state.prompt : (state.drafts[key] ?? '')

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
  drafts: {},
  setPrompt: (value) => set({ prompt: value }),
  resetPrompt: () => set({ prompt: '' }),
  bindDraft: (key) =>
    set((state) => {
      if (state.draftKey === key) return state
      if (state.draftKey === null) return { draftKey: key }
      const { [key]: restored = '', ...parked } = state.drafts
      return {
        draftKey: key,
        prompt: restored,
        drafts: park(parked, state.draftKey, state.prompt),
      }
    }),
  getDraft: (key) => selectDraft(key)(get()),
  setDraft: (key, value) =>
    set((state) =>
      owns(state.draftKey, key)
        ? { prompt: value, draftKey: key }
        : { drafts: park(state.drafts, key, value) }
    ),
}))
