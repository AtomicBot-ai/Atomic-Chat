/**
 * One GPU, two models, the Video page too. Loading a video model with
 * "always free the GPU" — the Images setting, shared — unloads the chat
 * model first, through the core; the next chat message brings the chat
 * model back, and the video model, small enough here to coexist, stays.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSessions, CRASH_TOAST, liveFakeBackends, pageShows, pickModel, send, waitForChat, watchFor } from '../harness/chat.js'
import { installFakeBackend, writeFakeModel } from '../harness/fixtures.js'
import { diffusionStatus, IMAGE_BACKEND_ID } from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import {
  generateVideo,
  installFakeVideoEngine,
  loadVideoModel,
  openVideos,
  VIDEO_ENGINE_TAG,
  videoSeed,
  videoTiles,
  writeFakeVideoModel,
} from '../harness/videos.js'

const MODEL_ID = 'e2e/fake-model'
const REPLY = 'ATOMIC-E2E-VIDEO-HANDOFF-3e7a'

/** Back from the Video page to the conversation: the sidebar's thread entry, named after the first prompt. */
async function openThread(session: Session, prompt: string): Promise<void> {
  const browser = session.app.browser
  await browser.$(`//*[contains(normalize-space(text()), "${prompt}")]`).click()
  await waitForChat(session)
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('freeing the GPU for a video model', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('video-chat-handoff-always', {
      webviewSeed: videoSeed({ setting: { evictChatModel: 'always' }, form: { frames: 9, steps: 2 } }),
      imageEngines: [`${VIDEO_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeBackend(profile, { reply: REPLY })
        await writeFakeModel(profile, MODEL_ID)
        await installFakeVideoEngine(profile)
        await writeFakeVideoModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('unloads the chat model before a video model loads when told to always free the GPU, and brings it back with the next message', async () => {
    await withArtifacts(session, async () => {
      const dataFolder = session.profile.dataFolder

      await waitForChat(session)
      await pickModel(session, MODEL_ID)
      await send(session, 'first message e2e-video-handoff')
      await pageShows(session, REPLY, 90_000)
      const [chat] = await coreSessions(dataFolder)
      expect(chat?.model_id).toBe(MODEL_ID)
      const crash = watchFor(session, CRASH_TOAST)

      // The video model evicts the chat model through the core, and the page says nothing went wrong.
      await openVideos(session)
      await loadVideoModel(session)
      await expect.poll(() => coreSessions(dataFolder), { timeout: 30_000 }).toEqual([])
      await expect.poll(() => liveFakeBackends(dataFolder), { timeout: 30_000 }).toEqual([])
      expect((await diffusionStatus(dataFolder)).model.loaded?.modality).toBe('video')
      const videoPid = (await diffusionStatus(dataFolder)).model.loaded?.pid
      await generateVideo(session, 'a boat while the chat model is gone')
      await session.app.browser.waitUntil(async () => (await videoTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'no clip',
      })

      // The next message loads the chat model again; the video model is small enough to stay.
      await openThread(session, 'first message e2e-video-handoff')
      await send(session, 'second message e2e-video-handoff')
      await pageShows(session, REPLY, 90_000)
      const [reloaded] = await coreSessions(dataFolder)
      expect(reloaded?.model_id).toBe(MODEL_ID)
      expect(reloaded?.pid).not.toBe(chat?.pid)
      expect((await diffusionStatus(dataFolder)).model.loaded?.pid).toBe(videoPid)
      expect(await crash.stop()).toBe(0)
    })
  }, 300_000)
})
