/**
 * Putting another llama.cpp backend under the app. The deterministic way in is
 * the one a user has offline: "Install Backend from File" in the provider's
 * settings, given a release archive. The archive holds the scripted backend
 * with a reply of its own, so the chat afterwards tells which one answered.
 *
 * The other way — a newer release offered by the core and applied by it from
 * the update banner — is `engine-update.spec.ts` (change
 * `unify-engine-lifecycle`): the desktop no longer installs an update on its own.
 */
import { mkdir, readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { buildBackendArchive } from '../harness/backend-mirror.js'
import { coreSessions, openProviderSettings, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { answerNextDialog, FAKE_BACKEND, FAKE_PROVIDER, installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { bundledBackends, endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const OLD_TAG = 'b99990'
const NEW_TAG = 'b99999'
const OLD_REPLY = 'ATOMIC-E2E-OLD-BACKEND 3e71'
const NEW_REPLY = 'ATOMIC-E2E-NEW-BACKEND 9d04'
const NEW_BACKEND = `${NEW_TAG}/${FAKE_BACKEND}`

/** The executable of the one model process the core runs, from its journal. */
async function runningExe(dataFolder: string): Promise<string> {
  const sessions = await coreSessions(dataFolder)
  expect(sessions.map((s) => s.model_id)).toEqual([MODEL_ID])
  const journal = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8')) as {
    processes: { pid: number; exe: string }[]
  }
  return journal.processes.find((p) => p.pid === sessions[0]!.pid)?.exe ?? ''
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('installing a backend from a file', () => {
  let session: Session
  let archive = ''

  beforeAll(async () => {
    session = await startSession('backend-install', {
      backendVersion: OLD_TAG,
      alsoAllowedBackends: [`${FAKE_PROVIDER}:${NEW_BACKEND}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { version: OLD_TAG, reply: OLD_REPLY })
        await writeFakeModel(profile, MODEL_ID)
        // Where a user's download would be: in their home, outside the app's data.
        const downloads = join(profile.home, 'Downloads')
        await mkdir(downloads, { recursive: true })
        archive = await buildBackendArchive(downloads, { tag: NEW_TAG, reply: NEW_REPLY })
      },
    })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('unpacks it, selects it, and runs the model on it from its next load', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const backends = join(dataFolder, FAKE_PROVIDER, 'backends')

      // Before: the model runs on the backend the profile came with.
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'which backend are you')
      await pageShows(session, OLD_REPLY, 90_000)
      expect(await runningExe(dataFolder)).toContain(`${OLD_TAG}/`)

      await openProviderSettings(session, FAKE_PROVIDER)
      const install = browser.$('//button[normalize-space(.)="Install Backend from File"]')
      await install.waitForClickable({ timeout: 30_000 })
      await answerNextDialog(session.profile, archive)
      await install.click()

      // The page says so, the binary is where the core looks for it, and the
      // provider's setting now names the new pair. The core's copy of that
      // setting follows with the next load, which is when the app hands its
      // settings over; it is checked after the chat below.
      await pageShows(session, `${NEW_TAG}-bin-${FAKE_BACKEND}`, 60_000)
      expect((await stat(join(backends, NEW_TAG, FAKE_BACKEND, 'build', 'bin', 'llama-server'))).mode & 0o111).not.toBe(0)
      await pageShows(session, NEW_BACKEND, 30_000)
      // The app's bundled build is unpacked on first launch beside the profile's own packs;
      // what the install added is the new tag next to the old one.
      const bundledTags = bundledBackends()
        .filter((entry) => entry.startsWith(`${FAKE_PROVIDER}:`))
        .map((entry) => entry.split(':')[1]!.split('/')[0]!)
      expect((await readdir(backends)).filter((tag) => !bundledTags.includes(tag)).sort()).toEqual([OLD_TAG, NEW_TAG])

      // A model that is already running stays on the backend it was started
      // with; the page does not say so. Selecting a backend decides the next
      // load, so the user stops the model here, on the same page.
      expect(await runningExe(dataFolder)).toContain(`${OLD_TAG}/`)
      const stop = browser.$(`//*[normalize-space(text())="${MODEL_ID}"]/ancestor::*[.//button[normalize-space(.)="Stop"]][1]//button[normalize-space(.)="Stop"]`)
      await stop.waitForClickable({ timeout: 30_000 })
      await stop.click()
      await expect.poll(() => coreSessions(dataFolder), { timeout: 30_000 }).toEqual([])

      // The next message loads it again — on what was installed.
      await browser.$('//*[normalize-space(text())="which backend are you"]').click()
      await waitForChat(session)
      await send(session, 'and now')
      await pageShows(session, NEW_REPLY, 90_000)
      expect(await runningExe(dataFolder)).toContain(`${NEW_TAG}/`)
      const coreSettings = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'settings.json'), 'utf8')) as {
        providers?: Record<string, Record<string, unknown>>
      }
      expect(coreSettings.providers?.[FAKE_PROVIDER]?.version_backend).toBe(NEW_BACKEND)
    })
  })
})
