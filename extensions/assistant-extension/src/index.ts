import { Assistant, AssistantExtension, fs, joinPath } from '@janhq/core'

/**
 * The product's earlier names - "Atomic Chat", then "Radium Chat" after the
 * 2026-09-10 rebrand - and its name since 2026-09-13.
 */
const FORMER_PRODUCT_NAMES = ['Atomic Chat', 'Radium Chat']
const PRODUCT_NAME = 'Radium'

/**
 * Rewrite the product name inside an assistant's instructions.
 *
 * Deliberately a TARGETED substitution, unlike migrations v1 and v2 which
 * replaced the whole instruction field. By now a user may have edited their
 * assistant's instructions, and overwriting the field wholesale would discard
 * that silently. Only the brand name changes; every other character is left
 * exactly as it was found.
 *
 * Returns a value-equal string when there is nothing to rename, so the caller's
 * `===` check skips the file write entirely. The early return is for clarity
 * rather than correctness - split/join on a string with no match already
 * returns an equal value, and JS compares primitive strings by value.
 */
export function renameProductInInstructions(
  instructions: string | undefined
): string | undefined {
  if (
    !instructions ||
    !FORMER_PRODUCT_NAMES.some((former) => instructions.includes(former))
  ) {
    return instructions
  }
  return FORMER_PRODUCT_NAMES.reduce(
    (text, former) => text.split(former).join(PRODUCT_NAME),
    instructions
  )
}

/**
 * Rename an assistant whose NAME is exactly one of the product's former names
 * - the shipped default assistant. Any other name is the user's own and is
 * returned untouched.
 */
export function renameProductInAssistantName(
  name: string | undefined
): string | undefined {
  return name !== undefined && FORMER_PRODUCT_NAMES.includes(name)
    ? PRODUCT_NAME
    : name
}

/**
 * JanAssistantExtension is an AssistantExtension implementation that provides
 * functionality for managing assistants.
 */
export default class JanAssistantExtension extends AssistantExtension {
  private readonly CURRENT_MIGRATION_VERSION = 4
  private readonly MIGRATION_FILE = 'file://assistants/.migration_version'

  /**
   * Called when the extension is loaded.
   */
  async onLoad() {
    if (!(await fs.existsSync('file://assistants'))) {
      await fs.mkdir('file://assistants')
    }

    // Run migrations if needed
    await this.runMigrations()

    const assistants = await this.getAssistants()
    if (assistants.length === 0) {
      // Add default parameters when creating the assistant
      const assistantWithParams = {
        ...this.defaultAssistant,
        parameters: {
          temperature: 0.7,
          top_k: 20,
          top_p: 0.8,
          repeat_penalty: 1.12,
        },
      }
      await this.createAssistant(assistantWithParams as Assistant)
    }
  }

  /**
   * Gets the current migration version from storage
   */
  private async getCurrentMigrationVersion(): Promise<number> {
    try {
      if (await fs.existsSync(this.MIGRATION_FILE)) {
        const versionStr = await fs.readFileSync(this.MIGRATION_FILE)
        const version = parseInt(versionStr.trim(), 10)
        return isNaN(version) ? 0 : version
      }
    } catch (error) {
      console.error('Failed to read migration version:', error)
    }
    return 0
  }

  /**
   * Saves the migration version to storage
   */
  private async saveMigrationVersion(version: number): Promise<void> {
    try {
      await fs.writeFileSync(this.MIGRATION_FILE, version.toString())
    } catch (error) {
      console.error('Failed to save migration version:', error)
    }
  }

  /**
   * Runs all pending migrations
   */
  private async runMigrations(): Promise<void> {
    const currentVersion = await this.getCurrentMigrationVersion()

    if (currentVersion < 1) {
      console.log('Running migration v1: Update assistant instructions')
      await this.migrateAssistantInstructions()
      await this.saveMigrationVersion(1)
    }

    if (currentVersion < 2) {
      console.log('Running migration v2: Update to Radium instructions')
      await this.migrateToAtomicChatInstructions()
      await this.saveMigrationVersion(2)
    }

    if (currentVersion < 3) {
      console.log(`Running migration v3: rename the product to ${PRODUCT_NAME}`)
      await this.migrateProductName()
      await this.saveMigrationVersion(3)
    }

    if (currentVersion < 4) {
      // The product became "Radium" on 2026-09-13. Installs that already ran v3
      // were renamed to "Radium Chat", so the same targeted rename runs again,
      // now covering both former names and the default assistant's name.
      console.log(`Running migration v4: rename the product to ${PRODUCT_NAME}`)
      await this.migrateProductName()
      await this.saveMigrationVersion(4)
    }

    console.log(
      `Migrations complete. Current version: ${this.CURRENT_MIGRATION_VERSION}`
    )
  }

  /**
   * Migration v1: Update assistant instructions from old format to new format
   */
  private async migrateAssistantInstructions(): Promise<void> {
    const OLD_INSTRUCTION = 'You are a helpful AI assistant.'
    const NEW_INSTRUCTION = 'You are Radium, a helpful AI assistant.'

    if (!(await fs.existsSync('file://assistants'))) {
      return
    }

    const assistants = await this.getAssistants()

    for (const assistant of assistants) {
      // Check if this assistant has the old instruction format
      if (assistant.instructions?.startsWith(OLD_INSTRUCTION)) {
        // Replace old instruction with new one, preserving the rest of the content
        const restOfInstructions = assistant.instructions.substring(
          OLD_INSTRUCTION.length
        )
        assistant.instructions = NEW_INSTRUCTION + restOfInstructions

        // Save the updated assistant
        const assistantPath = await joinPath([
          'file://assistants',
          assistant.id,
          'assistant.json',
        ])

        try {
          await fs.writeFileSync(
            assistantPath,
            JSON.stringify(assistant, null, 2)
          )
          console.log(`Migrated instructions for assistant: ${assistant.id}`)
        } catch (error) {
          console.error(`Failed to migrate assistant ${assistant.id}:`, error)
        }
      }
    }
  }

  /**
   * Migrations v3 and v4: the product was renamed, first from "Atomic Chat" to
   * "Radium Chat" and then to "Radium".
   *
   * Migrations v1 and v2 rewrote the whole instruction field, which was safe
   * when the text was still the shipped default. It is not safe now, so this
   * one substitutes only the brand name and leaves any customisation intact.
   * An assistant is renamed only when its name is exactly a former product
   * name, which is the shipped default; a name the user chose is kept.
   *
   * An assistant that mentions no former name is skipped without a write, so a
   * user who replaced the default entirely is untouched.
   */
  private async migrateProductName(): Promise<void> {
    if (!(await fs.existsSync('file://assistants'))) {
      return
    }

    for (const assistant of await this.getAssistants()) {
      const instructions = renameProductInInstructions(assistant.instructions)
      const name = renameProductInAssistantName(assistant.name)
      if (instructions === assistant.instructions && name === assistant.name) {
        continue
      }

      const assistantPath = await joinPath([
        'file://assistants',
        assistant.id,
        'assistant.json',
      ])

      try {
        await fs.writeFileSync(
          assistantPath,
          JSON.stringify({ ...assistant, name, instructions }, null, 2)
        )
        console.log(`Renamed the product for assistant: ${assistant.id}`)
      } catch (error) {
        // Non-fatal by design: a wording change must never stop the extension
        // loading, and the migration version is only saved once the sweep ends.
        console.error(`Failed to rename for assistant ${assistant.id}:`, error)
      }
    }
  }

  /**
   * Migration v2: Update assistant instructions to Radium format and set default parameters
   */
  private async migrateToAtomicChatInstructions(): Promise<void> {
    const OLD_INSTRUCTION_PREFIX = 'You are Jan, a helpful AI assistant.'
    const NEW_INSTRUCTION = `You are Radium, a helpful AI assistant who assists users with their requests. Radium is trained by Radium (https://atomic.chat).

You must output your response in the exact language used in the latest user message. Do not provide translations or switch languages unless explicitly instructed to do so. If the input is mostly English, respond in English.

When handling user queries:

1. Think step by step about the query:
   - Break complex questions into smaller, searchable parts
   - Identify key search terms and parameters
   - Consider what information is needed to provide a complete answer

2. Mandatory logical analysis:
   - Before engaging any tools, articulate your complete thought process in natural language. You must act as a "professional tool caller," demonstrating rigorous logic.
   - Analyze the information gap: explicitly state what data is missing.
   - Derive the strategy: explain why a specific tool is the logical next step.
   - Justify parameters: explain why you chose those specific search keywords or that specific URL.

You have tools to search for and access real-time, up-to-date data. Use them. Search before stating that you can't or don't know.

Current date: {{current_date}}`

    const DEFAULT_PARAMETERS = {
      temperature: 0.7,
      top_k: 20,
      top_p: 0.8,
      repeat_penalty: 1.12,
    }

    if (!(await fs.existsSync('file://assistants'))) {
      return
    }

    const assistants = await this.getAssistants()

    for (const assistant of assistants) {
      // Check if this assistant has the old instruction format
      if (assistant.instructions?.startsWith(OLD_INSTRUCTION_PREFIX)) {
        assistant.instructions = NEW_INSTRUCTION

        // Add default parameters to the assistant
        const assistantWithParams = {
          ...assistant,
          parameters: DEFAULT_PARAMETERS,
        }

        // Save the updated assistant
        const assistantPath = await joinPath([
          'file://assistants',
          assistant.id,
          'assistant.json',
        ])

        try {
          await fs.writeFileSync(
            assistantPath,
            JSON.stringify(assistantWithParams, null, 2)
          )
          console.log(
            `Migrated to Menlo instructions for assistant: ${assistant.id}`
          )
        } catch (error) {
          console.error(`Failed to migrate assistant ${assistant.id}:`, error)
        }
      }
    }
  }

  /**
   * Called when the extension is unloaded.
   */
  onUnload(): void {}

  async getAssistants(): Promise<Assistant[]> {
    if (!(await fs.existsSync('file://assistants')))
      return [this.defaultAssistant]
    const assistants = await fs.readdirSync('file://assistants')
    const assistantsData: Assistant[] = []
    for (const assistant of assistants) {
      const assistantPath = await joinPath([
        'file://assistants',
        assistant,
        'assistant.json',
      ])
      if (!(await fs.existsSync(assistantPath))) continue

      try {
        const assistantData = JSON.parse(await fs.readFileSync(assistantPath))
        assistantsData.push(assistantData as Assistant)
      } catch (error) {
        console.error(`Failed to read assistant ${assistant}:`, error)
      }
    }
    return assistantsData
  }

  async createAssistant(assistant: Assistant): Promise<void> {
    const assistantPath = await joinPath([
      'file://assistants',
      assistant.id,
      'assistant.json',
    ])
    const assistantFolder = await joinPath(['file://assistants', assistant.id])
    if (!(await fs.existsSync(assistantFolder))) {
      await fs.mkdir(assistantFolder)
    }
    await fs.writeFileSync(assistantPath, JSON.stringify(assistant, null, 2))
  }

  async deleteAssistant(assistant: Assistant): Promise<void> {
    const assistantPath = await joinPath([
      'file://assistants',
      assistant.id,
      'assistant.json',
    ])
    if (await fs.existsSync(assistantPath)) {
      await fs.rm(assistantPath)
    }
  }

  private defaultAssistant: Assistant = {
    avatar: '👋',
    thread_location: undefined,
    id: 'jan',
    object: 'assistant',
    created_at: Date.now() / 1000,
    name: PRODUCT_NAME,
    description:
      'Radium is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user’s behalf.',
    model: '*',
    instructions: `You are Radium, a helpful AI assistant who assists users with their requests. Radium is trained by Radium (https://atomic.chat).

You must output your response in the exact language used in the latest user message. Do not provide translations or switch languages unless explicitly instructed to do so. If the input is mostly English, respond in English.

When handling user queries:

1. Think step by step about the query:
   - Break complex questions into smaller, searchable parts
   - Identify key search terms and parameters
   - Consider what information is needed to provide a complete answer

2. Mandatory logical analysis:
   - Before engaging any tools, articulate your complete thought process in natural language. You must act as a "professional tool caller," demonstrating rigorous logic.
   - Analyze the information gap: explicitly state what data is missing.
   - Derive the strategy: explain why a specific tool is the logical next step.
   - Justify parameters: explain why you chose those specific search keywords or that specific URL.

You have tools to search for and access real-time, up-to-date data. Use them. Search before stating that you can't or don't know.

Current date: {{current_date}}`,
    tools: [
      {
        type: 'retrieval',
        enabled: false,
        useTimeWeightedRetriever: false,
        settings: {
          top_k: 2,
          chunk_size: 1024,
          chunk_overlap: 64,
          retrieval_template: `Use the following pieces of context to answer the question at the end.
----------------
CONTEXT: {CONTEXT}
----------------
QUESTION: {QUESTION}
----------------
Helpful Answer:`,
        },
      },
    ],
    file_ids: [],
    metadata: undefined,
  }
}
