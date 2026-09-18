/**
 * The app restarting itself — what the updater, a backend change and the data
 * folder move all end with. The restart must take the app's core down with it:
 * a core left running keeps the data folder's lock, and the app that comes up
 * has to wait for the vanished app's lease on it to lapse, about 45 s, before
 * it can start its own. For the user that is an app that is open and cannot
 * load a model.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { followRelaunch } from '../harness/app.js'
import { isAlive, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { readLock } from '../harness/core.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-RELAUNCH 1d6e'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the app restarting itself', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('relaunch', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('stops its core on the way out, and has a core of its own within fifteen seconds of coming back', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'before the restart')
      await pageShows(session, REPLY, 90_000)
      const previous = (await readLock(dataFolder))!
      expect(previous.state).toBe('ready')

      // The same call the updater and the settings pages make — scheduled rather
      // than made, so that this command is answered before the process that
      // answers it goes away; a WebDriver request caught mid-exit is retried by
      // the client for minutes.
      await session.app.browser.execute(() => {
        setTimeout(() => {
          void (window as unknown as { core?: { api?: { relaunch?: () => unknown } } }).core?.api?.relaunch?.()
        }, 500)
      })
      await followRelaunch(session.app)
      const relaunchedAt = Date.now()

      // The previous core went down with the app that owned it.
      expect(isAlive(previous.pid)).toBe(false)

      await expect
        .poll(
          async () => {
            const lock = await readLock(dataFolder)
            return lock?.state === 'ready' && lock.instance_id !== previous.instance_id
          },
          { timeout: 90_000, interval: 500 }
        )
        .toBe(true)
      expect(Date.now() - relaunchedAt).toBeLessThan(15_000)

      // And the restarted app is usable: the conversation is there and answered.
      await waitForChat(session)
      await session.app.browser.$('//*[normalize-space(text())="before the restart"]').click()
      await pageShows(session, REPLY, 30_000)
      await pickModel(session, MODEL_ID)
      await send(session, 'after the restart')
      await pageShows(session, REPLY, 90_000, 2)
    })
  }, 300_000)
})
