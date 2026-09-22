/**
 * One GPU, two models. Loading an image model with "always free the GPU"
 * unloads the chat model first, through the core; the next chat message
 * brings the chat model back, and the image model — small enough here to
 * coexist — stays. With "when needed", a chat model and an image model that
 * fit together are both kept.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSessions, CRASH_TOAST, liveFakeBackends, pageShows, pickModel, send, waitForChat, watchFor } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import {
  diffusionStatus,
  galleryTiles,
  generate,
  IMAGE_BACKEND_ID,
  IMAGE_ENGINE_TAG,
  imageSeed,
  installFakeImageEngine,
  loadImageModel,
  openImages,
  writeFakeImageModel,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-HANDOFF-9d2c'

/** Back from the Images page to the conversation: the sidebar's thread entry, named after the first prompt. */
async function openThread(session: Session, prompt: string): Promise<void> {
  const browser = session.app.browser
  await browser.$(`//*[contains(normalize-space(text()), "${prompt}")]`).click()
  await waitForChat(session)
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('freeing the GPU for an image model', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('image-chat-handoff-always', {
      webviewSeed: imageSeed({ setting: { evictChatModel: 'always' } }),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
        await installFakeImageEngine(profile)
        await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('unloads the chat model before an image model loads when told to always free the GPU, and brings it back with the next message', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'first message e2e-handoff')
      await pageShows(session, REPLY, 90_000)
      const [chat] = await coreSessions(dataFolder)
      expect(chat?.model_id).toBe(MODEL_ID)
      // From here on, an eviction must never look like a crash to the user.
      const crash = watchFor(session, CRASH_TOAST)

      // The image model evicts the chat model through the core, and the page says nothing went wrong.
      await openImages(session)
      await loadImageModel(session)
      await expect.poll(() => coreSessions(dataFolder), { timeout: 30_000 }).toEqual([])
      await expect.poll(() => liveFakeBackends(dataFolder), { timeout: 30_000 }).toEqual([])
      expect((await diffusionStatus(dataFolder)).model.state).toBe('loaded')
      const imagePid = (await diffusionStatus(dataFolder)).model.loaded?.pid
      await generate(session, 'a cube while the chat model is gone')
      await session.app.browser.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'no picture',
      })

      // The next message loads the chat model again; the image model is small enough to stay.
      await openThread(session, 'first message e2e-handoff')
      await send(session, 'second message e2e-handoff')
      await pageShows(session, REPLY, 90_000)
      await pageShows(session, REPLY, 5_000)
      const [reloaded] = await coreSessions(dataFolder)
      expect(reloaded?.model_id).toBe(MODEL_ID)
      expect(reloaded?.pid).not.toBe(chat?.pid)
      expect((await diffusionStatus(dataFolder)).model.loaded?.pid).toBe(imagePid)
      expect(await crash.stop()).toBe(0)
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('sharing the GPU when both fit', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('image-chat-handoff-when-needed', {
      webviewSeed: imageSeed({ setting: { evictChatModel: 'whenNeeded' } }),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
        await installFakeImageEngine(profile)
        await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('keeps the chat model loaded beside an image model that fits', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder
      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'a message e2e-coexist')
      await pageShows(session, REPLY, 90_000)
      const [chat] = await coreSessions(dataFolder)

      await openImages(session)
      await loadImageModel(session)
      expect((await diffusionStatus(dataFolder)).model.state).toBe('loaded')
      // Both fit: the fake models weigh bytes, and the machine's budget is real.
      expect(await coreSessions(dataFolder)).toEqual([expect.objectContaining({ pid: chat?.pid })])
      expect(liveFakeBackends(dataFolder)).toEqual([chat?.pid])
    })
  }, 300_000)
})
