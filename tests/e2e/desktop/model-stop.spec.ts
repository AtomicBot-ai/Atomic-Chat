/**
 * Stopping a model by hand. The app restarts a local model on its own whenever
 * the selected one is not running — that is what recovers a crashed backend —
 * so a deliberate stop has to be remembered as one, or the model the user just
 * stopped would come straight back. It stays down until the user asks for it
 * again, and sending a message is asking.
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
import { FAKE_PROVIDER, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-STOP 6e4b'

/** A button in the provider page's row for this model. */
const rowButton = (label: string) =>
  `//*[normalize-space(text())="${MODEL_ID}"]/ancestor::*[.//button[normalize-space(.)="${label}"]][1]//button[normalize-space(.)="${label}"]`

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a model stopped from its provider\'s settings', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('model-stop', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('goes down without a crash report, stays down, and comes back with the next message', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      const crashToast = watchFor(session, CRASH_TOAST)
      await pickModel(session, MODEL_ID)
      await send(session, 'before the stop')
      await pageShows(session, REPLY, 90_000)
      const running = (await coreSessions(dataFolder))[0]!.pid

      // Settings → the provider → Stop, in the running model's row.
      await browser.$('[data-test-id="model-picker-trigger"]').click()
      await browser.$('button[aria-label="Change model"]').click()
      await browser.$(`[data-test-id="provider-settings-${FAKE_PROVIDER}"]`).click()
      await browser.$(rowButton('Stop')).waitForClickable({ timeout: 30_000 })
      await browser.$(rowButton('Stop')).click()

      // The core unloaded it, the process is gone, and the row offers to start it.
      await expect.poll(() => coreSessions(dataFolder), { timeout: 30_000 }).toEqual([])
      await expect.poll(() => isAlive(running), { timeout: 15_000 }).toBe(false)
      await browser.$(rowButton('Start')).waitForDisplayed({ timeout: 15_000 })

      // Back in the conversation the model is still the selected one, which is
      // exactly when auto-start would bring it back. It must not.
      await browser.$(`//*[normalize-space(text())="before the stop"]`).click()
      await waitForChat(session)
      await browser.pause(6_000)
      expect(await coreSessions(dataFolder)).toEqual([])
      expect(liveFakeBackends(dataFolder)).toEqual([])

      // Asking for it again is what starts it.
      await send(session, 'after the stop')
      await pageShows(session, REPLY, 90_000, 2)
      expect(await coreSessions(dataFolder)).toHaveLength(1)

      expect(await crashToast.stop()).toBe(0)
    })
  })
})
