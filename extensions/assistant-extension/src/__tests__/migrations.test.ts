import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for the `file://assistants` tree the extension reads and
// writes through `@janhq/core`'s `fs`. Tests assert on the JSON that ends up
// in `assistant.json`, i.e. what the Run settings panel shows after launch.
const store = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
}))

vi.mock('@janhq/core', () => ({
  AssistantExtension: class {},
  joinPath: async (parts: string[]) => parts.join('/'),
  fs: {
    existsSync: async (path: string) =>
      store.files.has(path) || store.dirs.has(path),
    mkdir: async (path: string) => {
      store.dirs.add(path)
    },
    readFileSync: async (path: string) => {
      if (!store.files.has(path)) throw new Error(`ENOENT: ${path}`)
      return store.files.get(path)
    },
    writeFileSync: async (path: string, data: string) => {
      store.files.set(path, data)
    },
    readdirSync: async (path: string) => {
      const prefix = `${path}/`
      const names = new Set<string>()
      for (const key of [...store.files.keys(), ...store.dirs]) {
        if (key.startsWith(prefix))
          names.add(key.slice(prefix.length).split('/')[0])
      }
      return [...names]
    },
    rm: async (path: string) => {
      store.files.delete(path)
    },
  },
}))

import JanAssistantExtension from '../index'

const ASSISTANTS_DIR = 'file://assistants'
const VERSION_FILE = `${ASSISTANTS_DIR}/.migration_version`

// Verbatim from upstream Jan's migration v2 / default assistant
// (janhq/jan a4f909c9d, "fix: default instruction update (#7427)").
const JAN_MENLO_PROMPT = `You are Jan, a helpful AI assistant who assists users with their requests. Jan is trained by Menlo Research (https://www.menlo.ai).

You must output your response in the exact language used in the latest user message. Do not provide translations or switch languages unless explicitly instructed to do so. If the input is mostly English, respond in English.

When handling user queries:

1. Think step by step about the query:
   - Break complex questions into smaller, searchable parts

Current date: {{current_date}}`

const JAN_V1_PROMPT = 'You are Jan, a helpful AI assistant.'

const JAN_DEFAULT_DESCRIPTION =
  'Jan is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user’s behalf.'

const USER_PARAMETERS = {
  temperature: 1.5,
  top_k: 59,
  top_p: 0.35,
  repeat_penalty: 1,
  min_p: 0.83,
}

type StoredAssistant = Record<string, unknown> & { id: string }

const assistantPath = (id: string) => `${ASSISTANTS_DIR}/${id}/assistant.json`

const seedAssistant = (assistant: StoredAssistant) => {
  store.dirs.add(ASSISTANTS_DIR)
  store.dirs.add(`${ASSISTANTS_DIR}/${assistant.id}`)
  store.files.set(
    assistantPath(assistant.id),
    JSON.stringify(assistant, null, 2)
  )
}

const seedMigrationVersion = (version: number) => {
  store.dirs.add(ASSISTANTS_DIR)
  store.files.set(VERSION_FILE, String(version))
}

const readAssistant = (id: string): StoredAssistant =>
  JSON.parse(store.files.get(assistantPath(id)) ?? 'null')

const janDefaultAssistant = (): StoredAssistant => ({
  avatar: '👋',
  id: 'jan',
  object: 'assistant',
  created_at: 1738116452.1,
  name: 'Jan',
  description: JAN_DEFAULT_DESCRIPTION,
  model: '*',
  instructions: JAN_MENLO_PROMPT,
  parameters: USER_PARAMETERS,
  tools: [{ type: 'retrieval', enabled: false }],
  file_ids: [],
  sampling_overridden: true,
})

const launch = async () => {
  const extension = new JanAssistantExtension()
  await extension.onLoad()
  return extension
}

/** The prompt a fresh install gets: what every migrated install must match. */
const freshInstallInstructions = async (): Promise<string> => {
  store.files.clear()
  store.dirs.clear()
  await launch()
  const fresh = readAssistant('jan')
  store.files.clear()
  store.dirs.clear()
  return fresh.instructions as string
}

beforeEach(() => {
  store.files.clear()
  store.dirs.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

describe('assistant migration v3: Jan-branded prompts become Atomic Chat', () => {
  it('replaces the Jan/Menlo default prompt, name and description on a v2 install', async () => {
    const atomicInstructions = await freshInstallInstructions()
    expect(atomicInstructions).toMatch(
      /^You are Atomic Chat, a helpful AI assistant/
    )
    expect(atomicInstructions).not.toMatch(/Jan|Menlo/)

    seedAssistant(janDefaultAssistant())
    seedMigrationVersion(2)

    await launch()

    const migrated = readAssistant('jan')
    expect(migrated.instructions).toBe(atomicInstructions)
    expect(migrated.name).toBe('Atomic Chat')
    expect(migrated.description).toMatch(
      /^Atomic Chat is a helpful desktop assistant/
    )
    expect(migrated.description).not.toMatch(/Jan/)
    expect(store.files.get(VERSION_FILE)).toBe('3')
  })

  it('keeps the user’s sampling parameters and every other field', async () => {
    seedAssistant(janDefaultAssistant())
    seedMigrationVersion(2)

    await launch()

    const migrated = readAssistant('jan')
    expect(migrated.parameters).toEqual(USER_PARAMETERS)
    expect(migrated.sampling_overridden).toBe(true)
    expect(migrated.avatar).toBe('👋')
    expect(migrated.created_at).toBe(1738116452.1)
    expect(migrated.tools).toEqual([{ type: 'retrieval', enabled: false }])
    expect(migrated.file_ids).toEqual([])
    expect(migrated.model).toBe('*')
  })

  it('also migrates the period-terminated v1 prompt "You are Jan, a helpful AI assistant."', async () => {
    const atomicInstructions = await freshInstallInstructions()
    seedAssistant({
      ...janDefaultAssistant(),
      instructions: `${JAN_V1_PROMPT} Keep answers short.`,
    })
    seedMigrationVersion(2)

    await launch()

    expect(readAssistant('jan').instructions).toBe(atomicInstructions)
  })

  it('migrates a prompt that only carries the Menlo signature mid-text, and one with leading whitespace', async () => {
    const atomicInstructions = await freshInstallInstructions()
    seedAssistant({
      ...janDefaultAssistant(),
      id: 'menlo-mid',
      instructions:
        'Answer briefly. You were trained by Menlo Research (https://www.menlo.ai).',
    })
    seedAssistant({
      ...janDefaultAssistant(),
      id: 'leading-ws',
      instructions: `\n  ${JAN_MENLO_PROMPT}`,
    })
    seedMigrationVersion(2)

    await launch()

    expect(readAssistant('menlo-mid').instructions).toBe(atomicInstructions)
    expect(readAssistant('leading-ws').instructions).toBe(atomicInstructions)
  })

  it('leaves a user-authored prompt that merely mentions Jan untouched', async () => {
    const pirate: StoredAssistant = {
      ...janDefaultAssistant(),
      id: 'pirate',
      name: 'Captain',
      description: 'Talks like a pirate.',
      instructions: 'You are my pirate assistant, not Jan. Say arr.',
    }
    seedAssistant(pirate)
    const before = store.files.get(assistantPath('pirate'))
    seedAssistant({
      ...janDefaultAssistant(),
      id: 'lowercase',
      instructions: 'you are jan, my lowercase helper',
    })
    const beforeLowercase = store.files.get(assistantPath('lowercase'))
    seedMigrationVersion(2)

    await launch()

    expect(store.files.get(assistantPath('pirate'))).toBe(before)
    expect(readAssistant('pirate').name).toBe('Captain')
    expect(store.files.get(assistantPath('lowercase'))).toBe(beforeLowercase)
    expect(store.files.get(VERSION_FILE)).toBe('3')
  })

  it('is idempotent: a second launch changes nothing', async () => {
    seedAssistant(janDefaultAssistant())
    seedMigrationVersion(2)

    await launch()
    const afterFirst = store.files.get(assistantPath('jan'))
    expect(afterFirst).not.toContain('Menlo')

    await launch()

    expect(store.files.get(assistantPath('jan'))).toBe(afterFirst)
    expect(store.files.get(VERSION_FILE)).toBe('3')
  })

  it('brings an install with no version file all the way to v3', async () => {
    const atomicInstructions = await freshInstallInstructions()
    seedAssistant(janDefaultAssistant())

    await launch()

    expect(readAssistant('jan').instructions).toBe(atomicInstructions)
    expect(readAssistant('jan').name).toBe('Atomic Chat')
    expect(store.files.get(VERSION_FILE)).toBe('3')
  })
})
