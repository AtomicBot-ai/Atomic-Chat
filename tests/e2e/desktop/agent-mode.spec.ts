/**
 * Agent mode on a local model. The agent is a loop in the app's Rust side: it
 * builds one flat prompt, asks the model's backend for a raw completion under a
 * grammar, reads a JSON array of tool calls out of it, runs them, and goes round
 * again until the model replies. The scripted backend plays the model's part
 * with three fixed steps — read a file, write a file, reply — so everything
 * around them is the shipped loop: the session it borrows from the core, the
 * tools, the approval a write needs, and the transcript.
 */
import { mkdir, readFile, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { chooseFromMenu, coreSessions, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const NOTES = 'ATOMIC-E2E-AGENT-NOTES 3c9d: the ferry leaves at six.'
const WRITTEN = 'ATOMIC-E2E-AGENT-WROTE 70fa'
const ATTACH_MENU = 'button[aria-haspopup="menu"].rounded-full.mr-2'

describe.skipIf(!CAN_RUN_FAKE_BACKEND).each([
  { decision: 'Deny', name: 'refused' },
  // "Allow" grants the folder for this run; "Always Allow" would add it to the thread's folders.
  { decision: 'Allow', name: 'allowed' },
] as const)('agent mode on a local model, a folder outside the workspace $name', ({ decision, name }) => {
  let session: Session
  let notesPath = ''
  let outputPath = ''
  let outsidePath = ''

  beforeAll(async () => {
    session = await startSession(`agent-mode-${name}`, {
      prepare: async (profile) => {
        // The agent's default workspace is a folder inside the data folder.
        const workspace = join(profile.dataFolder, 'agent-workspace')
        await mkdir(workspace, { recursive: true })
        notesPath = join(workspace, 'field-notes.txt')
        outputPath = join(workspace, 'summary.txt')
        await writeFile(notesPath, NOTES)
        // Somewhere the agent has no standing: the user's own documents.
        await mkdir(join(profile.home, 'Documents'), { recursive: true })
        outsidePath = join(profile.home, 'Documents', 'agent-was-here.txt')
        const step = (tool: string, args: Record<string, unknown>) => JSON.stringify([{ tool, args }])
        await installFakeBackend(profile, {
          completionSteps: [
            step('os.fs.read', { path: notesPath }),
            step('os.fs.write', { path: outputPath, content: WRITTEN }),
            step('os.fs.write', { path: outsidePath, content: WRITTEN }),
            // Whether the notes were in the prompt by now is the model's to say.
            step('reply', { text: 'Done. Notes seen: {{seen:ATOMIC-E2E-AGENT-NOTES 3c9d}}.' }),
          ],
        })
        await writeFakeModel(profile, MODEL_ID, { tools: true })
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('reads and writes in its workspace, asks about a folder outside it, and replies with what it read in view', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await chooseFromMenu(session, ATTACH_MENU, 'Agent mode')
      await browser.$('[data-testid="agent-mode-chip"]').waitForDisplayed({ timeout: 15_000 })
      await send(session, 'summarise my field notes into summary.txt')

      // Inside its workspace the agent writes without asking.
      await expect.poll(() => readFile(outputPath, 'utf8').catch(() => ''), { timeout: 90_000 }).toBe(WRITTEN)

      // Outside it, the user decides first.
      await browser.waitUntil(
        async () => /Agent approval required|Allow folder access/.test(await browser.$('body').getText()),
        { timeout: 90_000, timeoutMsg: 'the agent never asked about the file outside its workspace' }
      )
      const asked = (await browser.$('body').getText()).replace(/\s+/g, ' ')
      // The prompt no longer names the tool that asked for the folder. What it must still say is
      // which folder, and what each answer costs — that is the whole of what the user decides on.
      expect(asked).toContain('Allow folder access')
      expect(asked).toContain('Allow grants access for this run')
      expect(asked).toContain(join(session.profile.home, 'Documents'))
      expect(await stat(outsidePath).then(() => true, () => false)).toBe(false)
      await browser.$(`//button[normalize-space(.)="${decision}"]`).click()

      // Allowing the folder is not yet approving the write: a further question
      // may follow, and is answered once.
      const finished = () => browser.$('body').getText().then((text) => text.includes('Notes seen:'))
      await browser.waitUntil(
        async () => {
          if (await finished()) return true
          const approve = browser.$('//button[normalize-space(.)="Approve once"]')
          if ((await approve.isExisting()) && (await approve.isDisplayed())) await approve.click()
          return false
        },
        { timeout: 90_000, interval: 500, timeoutMsg: 'the agent never finished its turn' }
      )

      // The turn ends either way, and the model had the notes in view — they
      // reach it only as the result of its own read.
      await pageShows(session, 'Notes seen: yes', 10_000)
      const written = await readFile(outsidePath, 'utf8').catch(() => null)
      expect(written).toBe(decision === 'Deny' ? null : WRITTEN)

      // The agent borrowed the chat model's session from the core; it started none of its own.
      expect((await coreSessions(session.profile.dataFolder)).map((s) => s.model_id)).toEqual([MODEL_ID])
    })
  }, 300_000)
})
