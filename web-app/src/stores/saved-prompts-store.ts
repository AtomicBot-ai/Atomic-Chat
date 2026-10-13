/**
 * The user's saved prompts.
 *
 * One list, two readers: Settings › Prompts edits it and the composer's Prompts
 * pill reads it, so a rename or a switch-off in settings shows in the pill at
 * once. `agent` prompts are the recurring jobs an agent does (PR triage,
 * performance checks); `chat` prompts are ordinary one-line asks.
 */

import { create } from 'zustand'
import { persist } from 'zustand/middleware'

export type PromptCategory = 'agent' | 'chat'

export type SavedPrompt = {
  id: string
  title: string
  category: PromptCategory
  description: string
  /** May contain `{{variables}}`, which are left in for the user to fill in. */
  body: string
  /** Whether the composer's Prompts pill lists it. */
  showInComposer: boolean
}

const starter = (
  id: string,
  title: string,
  category: PromptCategory,
  description: string,
  body: string
): SavedPrompt => ({ id, title, category, description, body, showInComposer: true })

export const STARTER_PROMPTS: SavedPrompt[] = [
  starter(
    'starter-pr-triage',
    'PR triage',
    'agent',
    'Rank open PRs by review priority',
    'Review every open pull request in {{repo}}. For each one give a one-line summary, CI status, merge conflicts, missing tests and a risk level (low, medium, high). Return a table ordered by what to review first and list the PRs that look ready to merge.'
  ),
  starter(
    'starter-perf-check',
    'GitHub performance check',
    'agent',
    'Regressions, slow tests, bundle size',
    'Check {{repo}} for performance regressions. Compare the last 5 CI runs, list the slowest tests, report bundle-size changes between the last two releases, and name any PR from the past 14 days that touched hot paths. Propose the three highest-impact fixes.'
  ),
  starter(
    'starter-dependency-audit',
    'Dependency and security audit',
    'agent',
    'Outdated packages and advisories',
    'Audit dependencies in {{repo}}. List packages with known advisories, packages two or more major versions behind, and anything unmaintained for over a year. Suggest an upgrade order and flag breaking changes.'
  ),
  starter(
    'starter-release-notes',
    'Release notes',
    'agent',
    'From PRs merged since the last tag',
    'Write release notes for {{repo}} from the pull requests merged since the last tag. Group them as Features, Fixes and Internal. Credit authors and link each PR.'
  ),
  starter(
    'starter-flaky-tests',
    'Flaky test hunt',
    'agent',
    'Find tests that fail intermittently',
    'Look through the last 30 CI runs of {{repo}} and find tests that failed and later passed on the same commit. Rank them by how often they flake and suggest a likely cause for each.'
  ),
  starter(
    'starter-issue-grooming',
    'Issue grooming',
    'agent',
    'Label, dedupe and prioritise',
    'Go through open issues in {{repo}}. Suggest labels, mark likely duplicates, and propose a priority for each. Do not close anything; list your recommendations.'
  ),
  starter(
    'starter-summarize',
    'Summarize',
    'chat',
    'Short bullet summary',
    'Summarize the following in a few clear bullet points:\n\n'
  ),
  starter(
    'starter-explain',
    'Explain simply',
    'chat',
    'For someone new to the topic',
    'Explain the following as if I am new to the topic:\n\n'
  ),
  starter(
    'starter-improve',
    'Improve writing',
    'chat',
    'Clearer, same meaning',
    'Improve the clarity and tone of this text without changing its meaning:\n\n'
  ),
]

type SavedPromptsState = {
  prompts: SavedPrompt[]
  /** Returns the new prompt's id. */
  add: (partial?: Partial<Omit<SavedPrompt, 'id'>>) => string
  update: (id: string, changes: Partial<Omit<SavedPrompt, 'id'>>) => void
  duplicate: (id: string) => string | null
  remove: (id: string) => void
  /** Put the starter prompts back, keeping anything the user added. */
  restoreStarters: () => void
}

const newId = () =>
  `prompt-${Date.now().toString(36)}-${Math.random().toString(36).slice(2, 6)}`

export const useSavedPrompts = create<SavedPromptsState>()(
  persist(
    (set, get) => ({
      prompts: STARTER_PROMPTS,
      add: (partial = {}) => {
        const id = newId()
        set((state) => ({
          prompts: [
            ...state.prompts,
            {
              title: 'New prompt',
              category: 'agent',
              description: '',
              body: '',
              showInComposer: true,
              ...partial,
              // Last, so a copied prompt can never carry its original's id.
              id,
            },
          ],
        }))
        return id
      },
      update: (id, changes) =>
        set((state) => ({
          prompts: state.prompts.map((prompt) =>
            prompt.id === id ? { ...prompt, ...changes } : prompt
          ),
        })),
      duplicate: (id) => {
        const source = get().prompts.find((prompt) => prompt.id === id)
        if (!source) return null
        return get().add({ ...source, title: `${source.title} (copy)` })
      },
      remove: (id) =>
        set((state) => ({
          prompts: state.prompts.filter((prompt) => prompt.id !== id),
        })),
      restoreStarters: () =>
        set((state) => {
          const have = new Set(state.prompts.map((prompt) => prompt.id))
          return {
            prompts: [
              ...STARTER_PROMPTS.filter((prompt) => !have.has(prompt.id)),
              ...state.prompts,
            ],
          }
        }),
    }),
    {
      name: 'radium-saved-prompts',
      version: 2,
      // Version 1 stored `{ id, title, text }` and nothing else.
      migrate: (persisted, version) => {
        const state = persisted as { prompts?: Array<Record<string, unknown>> }
        if (version < 2 && Array.isArray(state?.prompts)) {
          return {
            prompts: state.prompts.map((old) => ({
              id: String(old.id),
              title: String(old.title ?? 'Prompt'),
              category: 'chat' as PromptCategory,
              description: '',
              body: String(old.text ?? old.body ?? ''),
              showInComposer: true,
            })),
          } as unknown as SavedPromptsState
        }
        return persisted as SavedPromptsState
      },
    }
  )
)
