/**
 * Cancelling a model that is still loading, from the snackbar the load shows.
 * The core ends the backend it started (stage 7a), the app shows no crash,
 * and the next message loads the model again.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSessions, CRASH_TOAST, liveFakeBackends, pageShows, pickModel, send, waitForChat, watchFor } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-AFTER-CANCEL-7b3e'

async function journalled(dataFolder: string): Promise<unknown[]> {
  const journal = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8').catch(() => '{}')) as {
    processes?: unknown[]
  }
  return journal.processes ?? []
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('cancelling a model load', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('model-load-cancel', {
      prepare: async (profile) => {
        // Twenty seconds before the backend reports ready: long enough to cancel, short enough to wait out.
        await installFakeBackend(profile, { reply: REPLY, delayMs: 20_000 })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('cancels a model that is still loading from the snackbar, leaves no process behind, and loads it on the next try', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const crash = watchFor(session, CRASH_TOAST)

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      const toast = browser.$('//*[@data-sonner-toast][.//*[contains(normalize-space(.), "Starting Model")]]')
      await toast.waitForDisplayed({ timeout: 30_000 })
      await expect.poll(() => liveFakeBackends(dataFolder), { timeout: 30_000 }).toHaveLength(1)
      const [loading] = liveFakeBackends(dataFolder)

      await toast.$('button=Cancel').click()
      await browser.waitUntil(async () => !(await toast.isExisting()) || !(await toast.isDisplayed()), {
        timeout: 30_000,
        timeoutMsg: 'the load snackbar stayed',
      })
      // Nothing left of the load: no session, no process, no journal entry.
      await expect.poll(() => liveFakeBackends(dataFolder), { timeout: 30_000 }).toEqual([])
      expect(await coreSessions(dataFolder)).toEqual([])
      expect(await journalled(dataFolder)).toEqual([])
      expect(loading).toBeDefined()

      // A message loads it again, and this time it is allowed to finish.
      await send(session, 'after the cancel')
      await pageShows(session, REPLY, 120_000)
      const [loaded] = await coreSessions(dataFolder)
      expect(loaded?.model_id).toBe(MODEL_ID)
      expect(loaded?.pid).not.toBe(loading)
      expect(await crash.stop()).toBe(0)
    })
  }, 300_000)
})
