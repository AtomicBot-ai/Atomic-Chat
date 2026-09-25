/**
 * "Reset To Factory Settings": the app promises to erase everything and come
 * back as new. Checked against what a user has by then — a conversation, a
 * model, a cloud provider with its key — and against the two things the reset
 * is meant to keep: the downloaded backends, which are large, and whatever in
 * the folder is not the app's.
 */
import { execFileSync } from 'node:child_process'
import { readdir, stat, writeFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { followRelaunch } from '../harness/app.js'
import { chooseFromMenu, isAlive, pageShows, pickModel, send, waitForChat } from '../harness/chat.js'
import { readLock } from '../harness/core.js'
import {
  FAKE_BACKEND,
  FAKE_BACKEND_VERSION,
  FAKE_PROVIDER,
  installFakeBackend,
  startFakeCloud,
  writeFakeModel,
  type FakeCloud,
} from '../harness/fixtures.js'
import {
  IMAGE_BACKEND_ID,
  IMAGE_ENGINE_TAG,
  installFakeImageEngine,
  writeFakeImageModel,
  writeSourcePng,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-RESET 2f7c'
const API_KEY = 'sk-e2e-reset-key-91d4'
const rowInput = (title: string) => `//*[normalize-space(text())="${title}"]/ancestor::*[.//input][1]//input`

/** Files under `dir` that contain `text`. */
function filesContaining(dir: string, text: string): string[] {
  try {
    return execFileSync('grep', ['-rlF', '--', text, dir], { encoding: 'utf8' }).split('\n').filter(Boolean)
  } catch {
    return [] // grep exits 1 when nothing matches
  }
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a factory reset', () => {
  let session: Session
  let cloud: FakeCloud

  beforeAll(async () => {
    cloud = await startFakeCloud({ apiKey: API_KEY, model: 'e2e-cloud-model', reply: 'unused' })
    session = await startSession('factory-reset', {
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
        await writeFile(join(profile.dataFolder, 'users-own-notes.txt'), 'not the app\'s to delete')
        // And the image side: an engine, a model and a picture in the gallery.
        await installFakeImageEngine(profile)
        await writeFakeImageModel(profile)
        await writeSourcePng(join(profile.dataFolder, 'images', 'old-picture.png'))
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await cloud?.stop()
    expect(left).toEqual([])
  })

  it('erases the conversation, the model and the provider\'s key, keeps the backend, and starts over', async () => {
    await withArtifacts(session, async () => {
      let browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const backend = join(dataFolder, FAKE_PROVIDER, 'backends', FAKE_BACKEND_VERSION, FAKE_BACKEND, 'build', 'bin', 'llama-server')

      // What there is to lose: a conversation with a local model…
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'remember me')
      await pageShows(session, REPLY, 90_000)
      // …and a cloud provider connected with a key, which the core keeps for it.
      await browser.$('//*[normalize-space(text())="Cloud"]').click()
      await chooseFromMenu(session, '[data-test-id="cloud-provider-select"]', 'Custom (OpenAI-compatible)')
      await browser.$('input[placeholder="Enter name for provider"]').setValue('e2e-reset-cloud')
      await browser.$('button=Create').click()
      await browser.$(rowInput('Base URL')).waitForDisplayed({ timeout: 30_000 })
      await browser.$(rowInput('Base URL')).setValue(cloud.baseUrl)
      await browser.$(rowInput('API key')).setValue(API_KEY)
      await browser.$('button=Connect').click()
      await pageShows(session, 'Connected', 30_000)
      await expect
        .poll(() => filesContaining(dataFolder, API_KEY).map((file) => file.slice(dataFolder.length + 1)), { timeout: 30_000 })
        .toContain('atomic-core/credentials.json')
      const core = (await readLock(dataFolder))!

      await browser.$('//*[normalize-space(text())="Settings"]').click()
      const reset = browser.$('//button[@data-variant="destructive"][normalize-space(.)="Reset"]')
      await reset.scrollIntoView()
      await reset.click()
      await browser.$('[role="dialog"] button[aria-label="Reset"]').click()
      await followRelaunch(session.app)
      browser = session.app.browser

      // It comes back as a new install: onboarding, no conversation.
      await browser.$('button=Skip').waitForDisplayed({ timeout: 60_000 })
      expect(isAlive(core.pid)).toBe(false)

      // Gone from disk: the thread, the model, and the key — wherever it was kept.
      expect(await readdir(join(dataFolder, 'threads')).catch(() => [])).toEqual([])
      expect(await stat(join(dataFolder, 'llamacpp', 'models', ...MODEL_ID.split('/'))).then(() => true, () => false)).toBe(false)
      expect(filesContaining(dataFolder, API_KEY)).toEqual([])

      // Kept: the downloaded backend of the default provider, and the user's own file.
      expect((await stat(backend)).isFile()).toBe(true)
      expect((await stat(join(dataFolder, 'users-own-notes.txt'))).isFile()).toBe(true)
      // Gone with the rest: the image engine, the image models and the gallery.
      expect(await stat(join(dataFolder, 'diffusion')).catch(() => null)).toBeNull()
      expect(await stat(join(dataFolder, 'images')).catch(() => null)).toBeNull()
    })
  }, 300_000)
})
