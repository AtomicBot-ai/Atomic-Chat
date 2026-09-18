/**
 * Switching the local model mid-conversation. Only one llama.cpp model is kept
 * loaded, so picking another has to end the first one's backend process — a
 * leaked one holds the memory a real model needs — and the conversation has to
 * continue on the new session without the user doing anything else.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  CRASH_TOAST,
  coreSessions,
  isAlive,
  liveFakeBackends,
  pageShows,
  pickModel,
  send,
  waitForChat,
  watchFor,
} from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const FIRST_MODEL = 'e2e/model-one'
const SECOND_MODEL = 'e2e/model-two'
const REPLY = 'ATOMIC-E2E-SWITCH 2ac7'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('switching between two local models', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('model-switch', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, FIRST_MODEL)
        await writeFakeModel(profile, SECOND_MODEL)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('unloads the first model, ends its process, and answers from the second', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      const crashToast = watchFor(session, CRASH_TOAST)
      await pickModel(session, FIRST_MODEL)
      await send(session, 'to the first model')
      await pageShows(session, REPLY, 90_000)

      const before = await coreSessions(dataFolder)
      expect(before.map((s) => s.model_id)).toEqual([FIRST_MODEL])
      const firstBackend = before[0]!.pid

      await pickModel(session, SECOND_MODEL)
      await send(session, 'to the second model')
      await pageShows(session, REPLY, 90_000, 2)

      // One model, one process: the core's view, and the process table's.
      const after = await coreSessions(dataFolder)
      expect(after.map((s) => s.model_id)).toEqual([SECOND_MODEL])
      expect(isAlive(firstBackend)).toBe(false)
      expect(liveFakeBackends(dataFolder)).toEqual([after[0]!.pid])

      // The first backend was stopped on purpose. Reporting that as a crash
      // would cry wolf on the most ordinary thing a user does with two models.
      expect(await crashToast.stop()).toBe(0)
    })
  })
})
