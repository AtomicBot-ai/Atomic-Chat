import { Assistant, AssistantExtension, fs, joinPath } from '@janhq/core'
import { priorDefaultInstructions } from './legacy-default-instructions'
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

    if (currentVersion < this.CURRENT_MIGRATION_VERSION) {
      // v4 supersedes v1–v3. Running their broad matches first could destroy
      // customized prompts before the exact-match migration gets to see them.
      await this.migrateDefaultInstructions()
      await this.saveMigrationVersion(this.CURRENT_MIGRATION_VERSION)
    }
  }

  private async migrateDefaultInstructions(): Promise<void> {
    const assistants = await this.getAssistants()
    for (const assistant of assistants) {
      if (!priorDefaultInstructions.has(assistant.instructions)) continue

      const migrated: Assistant = {
        ...assistant,
        instructions: this.defaultAssistant.instructions,
      }
      if (assistant.name === 'Jan') {
        migrated.name = this.defaultAssistant.name
      }
      if (
        assistant.description ===
        'Jan is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user’s behalf.'
      ) {
        migrated.description = this.defaultAssistant.description
      }

      // Propagate write failures so the version is not advanced; successfully
      // migrated assistants no longer match, making the next launch safe to retry.
      await this.createAssistant(migrated)
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
    name: 'Atomic Chat',
    description:
      'Atomic Chat is a helpful desktop assistant that can reason through complex tasks and use tools to complete them on the user’s behalf.',
    model: '*',
    instructions:
      'You are Atomic Chat, a helpful AI assistant.\n\nCurrent date: {{current_date}}',
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
