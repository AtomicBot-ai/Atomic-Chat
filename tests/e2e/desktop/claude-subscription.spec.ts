/** Claude subscription UI over the real Tauri → core → fake official CLI boundary. */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { CORE_REPO } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import {
  endSession,
  startSession,
  withArtifacts,
  type Session,
} from '../harness/session.js'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)(
  'Claude subscription through the official CLI protocol',
  () => {
    let session: Session
    beforeAll(async () => {
      session = await startSession('claude-subscription', {
        prepare: async (profile) => {
          profile.env.ATOMIC_CLAUDE_CODE_EXECUTABLE = process.execPath
          profile.env.ATOMIC_TEST_CLAUDE_ENTRYPOINT = join(
            CORE_REPO,
            'test/helpers/fake-claude-code.mjs'
          )
          profile.env.ATOMIC_FAKE_CLAUDE_LOG = join(
            profile.root,
            'claude-calls.jsonl'
          )
        },
      })
    })
    afterAll(async () => {
      if (session) expect(await endSession(session)).toEqual([])
    })
    it('offers versioned Fable with the Claude logo and persists a streamed reply', async () => {
      await withArtifacts(session, async () => {
        await waitForChat(session)
        await pickModel(session, 'Claude Fable 5.1')
        await send(session, 'Claude subscription fixture greeting')
        await pageShows(session, 'OK', 30000)
        const browser = session.app.browser
        expect(
          await browser.$('img[alt="claude-code - Logo"]').isExisting()
        ).toBe(true)
        await send(session, 'Claude subscription fixture follow-up')
        await pageShows(session, 'OK', 30000, 2)
        const calls = (
          await readFile(
            join(session.profile.root, 'claude-calls.jsonl'),
            'utf8'
          )
        )
          .trim()
          .split('\n')
          .map((line) => JSON.parse(line))
        expect(
          calls.some(
            (call) =>
              call.input?.includes('fixture follow-up') &&
              call.args.includes('--resume')
          )
        ).toBe(true)
        const status = await (
          await coreRequest(session.profile.dataFolder, '/claude-code/status')
        ).text()
        expect(status).toContain('Claude Fable 5.1')
        expect(status).not.toContain('must-not-leave-status')
        const providers = await (
          await coreRequest(session.profile.dataFolder, '/cloud/providers')
        ).text()
        expect(providers).not.toContain('claude-code')
      })
    })
  }
)
