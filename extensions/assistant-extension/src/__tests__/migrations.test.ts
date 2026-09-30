import { beforeEach, describe, expect, it, vi } from 'vitest'

// In-memory stand-in for the `file://assistants` tree the extension reads and
// writes through `@janhq/core`'s `fs`. Tests assert on the JSON that ends up
// in `assistant.json`, i.e. what the Run settings panel shows after launch.
const store = vi.hoisted(() => ({
  files: new Map<string, string>(),
  dirs: new Set<string>(),
  failWrites: new Set<string>(),
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
      if (store.failWrites.has(path)) throw new Error('Disk write failed')
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
import priorDefaults from './fixtures/prior-defaults'

const SHORT_PROMPT =
  'You are Atomic Chat, a helpful AI assistant.\n\nCurrent date: {{current_date}}'
const JAN_MENLO_PROMPT = priorDefaults.find(
  ({ revision }) => revision === '9b5d90abd'
)!.instructions

const ASSISTANTS_DIR = 'file://assistants'
const VERSION_FILE = `${ASSISTANTS_DIR}/.migration_version`

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
  const extension = new JanAssistantExtension(
    'file://assistant-extension',
    'assistant-extension'
  )
  await extension.onLoad()
  return extension
}

beforeEach(() => {
  store.files.clear()
  store.dirs.clear()
  store.failWrites.clear()
  vi.spyOn(console, 'log').mockImplementation(() => {})
})

const priorInstructions = [
  ...priorDefaults.map(({ instructions }) => instructions),
  ...priorDefaults.flatMap(({ instructions }) =>
    instructions.startsWith('You are a helpful AI assistant.')
      ? ['Jan', 'Atomic Chat'].map((name) =>
          instructions.replace(
            'You are a helpful AI assistant.',
            `You are ${name}, a helpful AI assistant.`
          )
        )
      : []
  ),
  'You are a helpful AI assistant.',
  'You are Jan, a helpful AI assistant.',
  'You are Atomic Chat, a helpful AI assistant.',
  'Current date: {{current_date}}',
]

describe('short default assistant instructions', () => {
  it('creates a fresh install with the short prompt, date template and sampling defaults', async () => {
    await launch()
    expect(readAssistant('jan')).toMatchObject({
      name: 'Atomic Chat',
      instructions: SHORT_PROMPT,
      parameters: {
        temperature: 0.7,
        top_k: 20,
        top_p: 0.8,
        repeat_penalty: 1.12,
      },
    })
    expect(store.files.get(VERSION_FILE)).toBe('4')
  })

  it('uses the same short default when the assistant directory is absent', async () => {
    expect(
      (
        await new JanAssistantExtension(
          'file://assistant-extension',
          'assistant-extension'
        ).getAssistants()
      )[0].instructions
    ).toBe(SHORT_PROMPT)
  })

  for (const version of [undefined, 0, 1, 2, 3]) {
    it(`migrates every exact historical default from version ${version ?? 'missing'} and preserves other fields`, async () => {
      const originals = priorInstructions.map((instructions, i) => ({
        ...janDefaultAssistant(),
        id: `assistant-${i}`,
        name: 'My assistant',
        description: 'My description',
        instructions,
      }))
      originals.forEach(seedAssistant)
      if (version !== undefined) seedMigrationVersion(version)
      await launch()
      for (const original of originals) {
        expect(readAssistant(original.id)).toEqual({
          ...original,
          instructions: SHORT_PROMPT,
        })
      }
      expect(store.files.get(VERSION_FILE)).toBe('4')
    })

    it(`preserves customized prompts byte for byte from version ${version ?? 'missing'}`, async () => {
      const customInstructions = [
        ...priorInstructions
          .flatMap((instructions) => [
            `${instructions} Keep answers short.`,
            ` ${instructions}`,
            `${instructions}\n`,
            instructions.replace('helpful', 'specialized'),
          ])
          .filter((instructions) => !priorInstructions.includes(instructions)),
        'You are Jan, my coding assistant.',
        'Answer briefly. You were trained by Menlo Research (https://www.menlo.ai).',
        'Explain menlo.ai.',
        'You are my pirate assistant, not Jan. Say arr.',
        '',
        undefined,
        null,
        SHORT_PROMPT,
      ]
      const originals = customInstructions.map((instructions, i) => ({
        ...janDefaultAssistant(),
        id: `custom-${i}`,
        instructions,
      }))
      originals.forEach(seedAssistant)
      const before = new Map(store.files)
      if (version !== undefined) seedMigrationVersion(version)
      await launch()
      for (const original of originals) {
        expect(store.files.get(assistantPath(original.id))).toBe(
          before.get(assistantPath(original.id))
        )
      }
      expect(store.files.get(VERSION_FILE)).toBe('4')
    })
  }

  it('rebrands exact Jan defaults while preserving sampling, tools and metadata', async () => {
    const original = janDefaultAssistant()
    seedAssistant(original)
    seedMigrationVersion(2)
    await launch()
    expect(readAssistant('jan')).toEqual({
      ...original,
      name: 'Atomic Chat',
      instructions: SHORT_PROMPT,
      description:
        'Atomic Chat is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user’s behalf.',
    })
  })

  it('retries a failed assistant write without advancing the migration version', async () => {
    seedAssistant(janDefaultAssistant())
    seedMigrationVersion(3)
    const original = store.files.get(assistantPath('jan'))
    store.failWrites.add(assistantPath('jan'))
    await expect(launch()).rejects.toThrow('Disk write failed')
    expect(store.files.get(VERSION_FILE)).toBe('3')
    expect(store.files.get(assistantPath('jan'))).toBe(original)
    store.failWrites.clear()
    await launch()
    expect(readAssistant('jan').instructions).toBe(SHORT_PROMPT)
    expect(store.files.get(VERSION_FILE)).toBe('4')
  })

  it('preserves absent sampling parameters on older assistants', async () => {
    seedAssistant({ id: 'legacy', instructions: JAN_MENLO_PROMPT })
    await launch()
    expect(readAssistant('legacy')).toEqual({
      id: 'legacy',
      instructions: SHORT_PROMPT,
    })
  })

  it('leaves a future migration version and its assistants untouched', async () => {
    seedAssistant(janDefaultAssistant())
    seedMigrationVersion(5)
    const before = new Map(store.files)
    await launch()
    expect(store.files).toEqual(before)
  })

  it('is idempotent and leaves subsequent edits intact', async () => {
    seedAssistant(janDefaultAssistant())
    seedMigrationVersion(3)
    await launch()
    const afterFirst = new Map(store.files)
    await launch()
    expect(store.files).toEqual(afterFirst)
    seedAssistant({ ...readAssistant('jan'), instructions: 'My custom prompt' })
    await launch()
    expect(readAssistant('jan').instructions).toBe('My custom prompt')
    expect(store.files.get(VERSION_FILE)).toBe('4')
  })
})
