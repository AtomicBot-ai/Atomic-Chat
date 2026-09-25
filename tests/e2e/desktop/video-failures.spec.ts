/**
 * When the engine fails a clip, the Video page says so and recovers; and a
 * generation stopped halfway leaves nothing behind and keeps the engine.
 * The engine is the core's scripted `sd-server` in video mode and its
 * failure modes; see harness/videos.ts.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diffusionStatus, IMAGE_BACKEND_ID, liveFakeSdServers } from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import {
  generateVideo,
  installFakeVideoEngine,
  loadVideoModel,
  openVideos,
  VIDEO_ENGINE_TAG,
  videoGalleryOnDisk,
  videoJob,
  videoSeed,
  videoTiles,
  writeFakeVideoModel,
} from '../harness/videos.js'

const BANNER = '[data-testid="image-error-banner"]'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a clip the engine fails', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('video-fail-job', {
      webviewSeed: videoSeed({ form: { frames: 9, steps: 2 } }),
      imageEngines: [`${VIDEO_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeVideoEngine(profile, { mode: 'fail-job' })
        await writeFakeVideoModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('says what went wrong when the engine fails a clip, and lets the user try again', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await openVideos(session)
      await loadVideoModel(session)
      const pid = (await diffusionStatus(dataFolder)).model.loaded?.pid as number

      await generateVideo(session, 'a boat')
      await browser.$(BANNER).waitForDisplayed({ timeout: 60_000 })
      expect(await browser.$(BANNER).getAttribute('role')).toBe('alert')
      // The engine's failure was an out-of-memory verdict; the banner offers the smallest size.
      expect(await browser.$(BANNER).getText()).toMatch(/memory/i)
      expect(await browser.$('button=Try the smallest size').isExisting()).toBe(true)
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 15_000 })
      expect(await videoTiles(session)).toEqual([])
      expect(await videoGalleryOnDisk(join(dataFolder, 'videos'))).toEqual([])
      // A failed job is the engine's verdict, not its death: it is still the resident server.
      const status = await diffusionStatus(dataFolder)
      expect(status.model.loaded?.pid).toBe(pid)
      expect(status.activeVideoJob).toBeNull()
      expect(liveFakeSdServers(dataFolder)).toEqual([pid])
    })
  }, 180_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('stopping a clip', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('video-stop', {
      // Twenty slow steps: long enough to press Stop in the middle.
      webviewSeed: videoSeed({ form: { frames: 9, steps: 20 } }),
      imageEngines: [`${VIDEO_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeVideoEngine(profile, { stepMs: 400, cancel: true })
        await writeFakeVideoModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('stops a clip: Generate comes back, nothing lands in the gallery, and the next clip is made by the same process', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await openVideos(session)
      await loadVideoModel(session)
      const pid = (await diffusionStatus(dataFolder)).model.loaded?.pid as number

      await generateVideo(session, 'a long render')
      await browser.$('[data-testid="image-stop"]').waitForDisplayed({ timeout: 15_000 })
      const jobId = await browser.waitUntil(
        async () => (await diffusionStatus(dataFolder)).activeVideoJob?.id,
        { timeout: 15_000, timeoutMsg: 'the job never started' }
      )
      await browser.$('[data-testid="image-stop"]').click()
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 30_000 })

      expect((await videoJob(dataFolder, jobId as string))?.state).toBe('cancelled')
      expect(await videoTiles(session)).toEqual([])
      expect(await videoGalleryOnDisk(join(dataFolder, 'videos'))).toEqual([])
      // A stop the user asked for is not an error.
      expect(await browser.$('[data-testid="image-error-banner"]').isExisting()).toBe(false)
      // The engine honoured the cancel natively, so it is still the same process.
      expect((await diffusionStatus(dataFolder)).model.loaded?.pid).toBe(pid)

      await generateVideo(session, 'a short one')
      await browser.waitUntil(async () => (await videoTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'the next clip never arrived',
      })
      expect((await diffusionStatus(dataFolder)).model.loaded?.pid).toBe(pid)
    })
  }, 300_000)
})
