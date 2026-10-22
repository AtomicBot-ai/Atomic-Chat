/**
 * A terminal command from a chat. The scripted chat model's one move is to call
 * `run_command`; the app asks first — commands are never covered by the global
 * MCP auto-approve switch — and only runs it once the user allows it, in the
 * chat's own folder. What the command printed comes back to the model, which
 * repeats it in its reply.
 */
import { readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import { startNewChat } from '../harness/navigation.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-EXEC 4d1c'
const PRINTED = 'ATOMIC-E2E-EXEC-PRINTED 9b27'
const MADE = 'made-by-chat.txt'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a terminal command in a chat', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('chat-command', {
      prepare: async (profile) => {
        await installFakeBackend(profile, {
          reply: REPLY,
          toolCall: {
            name: 'run_command',
            arguments: { command: `echo ${PRINTED} > ${MADE} && cat ${MADE}` },
          },
        })
        await writeFakeModel(profile, MODEL_ID, { tools: true })
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  const chatFolders = async () => {
    const root = join(session.profile.dataFolder, 'agent-workspace', 'chat')
    return readdir(root).catch(() => [] as string[])
  }

  const newChat = async () => {
    await startNewChat(session.app.browser)
    await waitForChat(session)
  }

  it('asks first, and a refusal runs nothing', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'write a file and show it')

      await pageShows(session, 'Run this command?', 60_000)
      expect(await browser.$('[data-testid="exec-approval-source"]').getText()).toContain(PRINTED)
      await browser.$('//button[normalize-space(.)="Deny"]').click()
      await pageShows(session, 'Tool execution denied by user', 60_000)

      for (const folder of await chatFolders()) {
        const made = join(session.profile.dataFolder, 'agent-workspace', 'chat', folder, MADE)
        await expect(readFile(made, 'utf8')).rejects.toThrow()
      }
    })
  }, 300_000)

  it('runs the allowed command in the chat folder and hands its output to the model', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await newChat()
      await send(session, 'write the file again')

      await pageShows(session, 'Run this command?', 60_000)
      await browser.$('//button[normalize-space(.)="Allow Once"]').click()
      // The reply repeats the tool's result: the printed line reached the model.
      await pageShows(session, PRINTED, 60_000)

      const written: string[] = []
      for (const folder of await chatFolders()) {
        const text = await readFile(
          join(session.profile.dataFolder, 'agent-workspace', 'chat', folder, MADE),
          'utf8'
        ).catch(() => undefined)
        if (text) written.push(text.trim())
      }
      expect(written).toEqual([PRINTED])
    })
  }, 300_000)
})
