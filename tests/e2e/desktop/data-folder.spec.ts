/**
 * Moving the data folder from Settings. The app copies everything to the new
 * place, records the new path in its configuration and restarts itself; from
 * then on the new folder is the only one that counts — threads, models, the
 * backend and the core's own state all have to be found there. When the copy
 * cannot happen, nothing may change: the old folder stays the one in charge.
 *
 * The folder picker is a native dialog, which an e2e build answers from a queue
 * the test fills in advance; everything after the pick is the shipped code.
 */
import { chmod, mkdir, readdir, readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { followRelaunch, invoke } from '../harness/app.js'
import { coreSessions, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { readLock } from '../harness/core.js'
import { answerNextDialog, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-FOLDER 9c35'
const FIRST_PROMPT = 'written before the move'

/** Measured by the move scenario, judged by the known-defect test after it. */
let latestCoreReadyAfterMs = Number.NaN

const confirmButton = '//*[@role="dialog"]//button[normalize-space(.)="Change Location"]'

async function chatOnce(session: Session, prompt: string, replies: number): Promise<void> {
  await send(session, prompt)
  await pageShows(session, REPLY, 90_000, replies)
}

async function askToMoveTo(session: Session, folder: string): Promise<void> {
  const browser = session.app.browser
  await answerNextDialog(session.profile, folder)
  await browser.$('//*[normalize-space(text())="Settings"]').click()
  await browser.$('button=Change Location').waitForClickable({ timeout: 30_000 })
  await browser.$('button=Change Location').click()
  await pageShows(session, folder, 15_000)
  await browser.$(confirmButton).click()
}

async function storedMessages(dataFolder: string): Promise<string> {
  const threads = await readdir(join(dataFolder, 'threads')).catch(() => [] as string[])
  const files = await Promise.all(
    threads.map((id) => readFile(join(dataFolder, 'threads', id, 'messages.jsonl'), 'utf8').catch(() => ''))
  )
  return files.join('\n')
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('moving the data folder', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('data-folder-move', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('restarts on the new folder with the conversation, the model and the core in it', async () => {
    await withArtifacts(session, async () => {
      const original = session.profile.dataFolder
      const moved = join(session.profile.root, 'moved-data')

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await chatOnce(session, FIRST_PROMPT, 1)

      session.dataFolders.push(moved)
      const previousCore = (await readLock(original))!
      await askToMoveTo(session, moved)
      await followRelaunch(session.app)
      const relaunchedAt = Date.now()
      const browser = session.app.browser

      // The configuration, as the app reports it and as it lies on disk.
      await waitForChat(session)
      const config = await invoke<{ data_folder: string }>(browser, 'get_app_configurations')
      expect(config.data_folder).toBe(moved)
      expect(JSON.parse(await readFile(join(session.profile.root, 'settings.json'), 'utf8')).data_folder).toBe(moved)

      // The conversation came along and is read from the new place.
      expect(await storedMessages(moved)).toContain(REPLY)
      const thread = browser.$(`//*[normalize-space(text())="${FIRST_PROMPT}"]`)
      await thread.waitForDisplayed({ timeout: 30_000 })
      await thread.click()
      await pageShows(session, REPLY, 30_000)

      // The core serves the new folder, and a model loads from it: the next
      // message is answered and lands in the new folder only.
      // Its own core, not the previous one's lock file that the move copied along.
      await expect
        .poll(async () => {
          const lock = await readLock(moved)
          return lock?.state === 'ready' && lock.instance_id !== previousCore.instance_id
        }, { timeout: 90_000, interval: 500 })
        .toBe(true)
      latestCoreReadyAfterMs = Date.now() - relaunchedAt
      await pickModel(session, MODEL_ID)
      await chatOnce(session, 'written after the move', 2)
      expect(await coreSessions(moved)).toHaveLength(1)
      expect(await storedMessages(moved)).toContain('written after the move')
      expect(await storedMessages(original)).not.toContain('written after the move')
    })
  })
})

// The move stops the core before copying its folder and leaves the core's own
// runtime state (lock, token, process journal) behind, so the restarted app
// starts a core on the new folder at once. Before that was so, the copied lock
// named the old, still-running core, and the new folder went unserved for about
// 40 s — until that core's registration of the vanished app lapsed.
describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the core after a data folder move', () => {
  it('is serving the new folder within fifteen seconds of the restart', () => {
    expect(latestCoreReadyAfterMs).toBeLessThan(15_000)
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a data folder move that cannot be carried out', () => {
  let session: Session
  let locked = ''

  beforeAll(async () => {
    session = await startSession('data-folder-move-fails', {
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
        // A place nothing can be created in: the copy fails before it starts.
        locked = join(profile.root, 'locked')
        await mkdir(locked)
        await chmod(locked, 0o555)
      },
    })
  })

  afterAll(async () => {
    await chmod(locked, 0o755).catch(() => undefined)
    expect(await endSession(session)).toEqual([])
  })

  it('says so, does not restart, and keeps the old folder in charge', async () => {
    await withArtifacts(session, async () => {
      const original = session.profile.dataFolder
      const appProcess = session.app.child

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await chatOnce(session, FIRST_PROMPT, 1)

      await askToMoveTo(session, join(locked, 'moved-data'))
      // The page gives the reason the command gave, not a general apology.
      await pageShows(session, 'Failed to create new data folder', 30_000)
      await pageShows(session, 'ermission denied', 5_000)

      // No restart happened, and the configuration still names the old folder.
      expect(appProcess.exitCode).toBeNull()
      const config = await invoke<{ data_folder: string }>(session.app.browser, 'get_app_configurations')
      expect(config.data_folder).toBe(original)
      expect(JSON.parse(await readFile(join(session.profile.root, 'settings.json'), 'utf8')).data_folder).toBe(original)

      // The app is still usable as it is: the model answers without a restart.
      await session.app.browser.keys('Escape')
      await session.app.browser.$(`//*[normalize-space(text())="${FIRST_PROMPT}"]`).click()
      await waitForChat(session)
      await chatOnce(session, 'after the refusal', 2)

      // After a restart the user chooses to make, the conversation is there.
      await restartApp(session)
      await waitForChat(session)
      const thread = session.app.browser.$(`//*[normalize-space(text())="${FIRST_PROMPT}"]`)
      await thread.waitForDisplayed({ timeout: 30_000 })
      await thread.click()
      await pageShows(session, REPLY, 30_000)
    })
  })
})
