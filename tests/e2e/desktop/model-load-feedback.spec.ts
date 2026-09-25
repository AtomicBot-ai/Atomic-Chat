/**
 * What the user sees while a model is being loaded into memory. A local model takes seconds to
 * minutes to become answerable, and the only thing standing between the user and a frozen-looking
 * app is this chain: a snackbar that says it started, an indicator that keeps saying it, and a word
 * when it is ready. The fake backend holds its readiness line back so the chain is observable at
 * all — with a backend that is ready at once there is nothing to see.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'

import { pageShows, pickModel, send, waitForChat, watchFor } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/slow-model'
const REPLY = 'ATOMIC-E2E-LOAD-FEEDBACK 7c41'
/** Long enough for the loading state to be sampled, short enough not to pad the suite. */
const LOAD_MS = 4000

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a model being loaded into memory', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('model-load-feedback', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY, delayMs: LOAD_MS })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('says it started, says what it is doing, and says when it is ready', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      await waitForChat(session)
      await pickModel(session, MODEL_ID)

      // Watched from before the message: the snackbar is up only while the load runs, and the
      // ready one clears itself after three seconds, so a look afterwards would miss both.
      const started = watchFor(session, 'Starting Model')
      const loading = watchFor(session, 'Loading into memory')
      const ready = watchFor(session, 'Model ready')

      await send(session, 'hello, slow model')
      await pageShows(session, REPLY, 120_000)

      expect(await started.stop(), 'the user was told the model started').toBeGreaterThan(0)
      expect(await loading.stop(), 'and told what it was doing').toBeGreaterThan(0)
      expect(await ready.stop(), 'and told when it could answer').toBeGreaterThan(0)

      // The indicator agrees with the snackbar once the answer is in: the model is loaded, and
      // stays that way, which is what makes the next message instant.
      const indicator = browser.$('[data-testid="active-model-indicator"]')
      await expect
        .poll(async () => indicator.getAttribute('data-status').catch(() => null), { timeout: 15_000 })
        .toBe('ready')
    })
  })
})
