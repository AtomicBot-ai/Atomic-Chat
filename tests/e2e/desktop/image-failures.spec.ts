/**
 * When the image engine fails a picture, the page says so and recovers: a job
 * the engine fails shows the error banner and Generate comes back; an engine
 * that dies in the middle of a picture leaves no process behind and the next
 * picture brings a fresh one. The engine is the core's scripted `sd-server`
 * in its failure modes; see harness/images.ts.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import {
  diffusionJob,
  diffusionStatus,
  galleryOnDisk,
  galleryTiles,
  generate,
  IMAGE_BACKEND_ID,
  IMAGE_ENGINE_TAG,
  imageSeed,
  installFakeImageEngine,
  liveFakeSdServers,
  loadImageModel,
  openImages,
  sdPids,
  writeFakeImageModel,
  type FakeImageEngine,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const BANNER = '[data-testid="image-error-banner"]'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('a picture the engine fails', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('image-fail-job', {
      webviewSeed: imageSeed(),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeImageEngine(profile, { mode: 'fail-job' })
        await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('says what went wrong when the engine fails a picture, and lets the user try again', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await openImages(session)
      await loadImageModel(session)
      const pid = (await diffusionStatus(dataFolder)).model.loaded?.pid as number

      await generate(session, 'a cube')
      await browser.$(BANNER).waitForDisplayed({ timeout: 60_000 })
      expect(await browser.$(BANNER).getAttribute('role')).toBe('alert')
      // The engine's failure was an out-of-memory verdict; the banner offers what fixes it.
      expect(await browser.$(BANNER).getText()).toMatch(/memory/i)
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 15_000 })
      expect(await galleryTiles(session)).toEqual([])
      expect(await galleryOnDisk(join(dataFolder, 'images'))).toEqual([])
      // A failed job is the engine's verdict, not its death: it is still the resident server.
      const status = await diffusionStatus(dataFolder)
      expect(status.model.loaded?.pid).toBe(pid)
      expect(status.activeJob).toBeNull()
      expect(liveFakeSdServers(dataFolder)).toEqual([pid])
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('an engine that dies mid-picture', () => {
  let session: Session
  let engine: FakeImageEngine

  beforeAll(async () => {
    session = await startSession('image-die-mid-job', {
      webviewSeed: imageSeed(),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        // Only the first process dies; the one the next picture brings up completes.
        engine = await installFakeImageEngine(profile, {
          mode: 'die-mid-job',
          onceMarker: join(profile.root, 'died-once'),
        })
        await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('tells the user when the engine dies in the middle of a picture, leaves no process behind, and makes the next one on a fresh engine', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await openImages(session)
      await loadImageModel(session)
      const pid = (await diffusionStatus(dataFolder)).model.loaded?.pid as number

      await generate(session, 'a cube')
      const jobId = await browser.waitUntil(
        async () => (await diffusionStatus(dataFolder)).activeJob?.id,
        { timeout: 15_000, timeoutMsg: 'the job never started' }
      )
      await browser.$(BANNER).waitForDisplayed({ timeout: 60_000 })
      expect((await diffusionJob(dataFolder, jobId as string))?.error?.code).toBe('OUT_OF_MEMORY')
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 15_000 })
      // The process is gone and the core knows it; the model is remembered for a respawn.
      await browser.waitUntil(async () => liveFakeSdServers(dataFolder).length === 0, {
        timeout: 15_000,
        timeoutMsg: 'the dead engine is still listed',
      })
      expect((await diffusionStatus(dataFolder)).model.loaded).toBeNull()
      expect(await galleryTiles(session)).toEqual([])

      // The page shows the model as stopped: Run brings a fresh engine up, and the next picture is made.
      await browser.$(`${BANNER} button[aria-label="Close"]`).click()
      await loadImageModel(session)
      await generate(session, 'a cube, again')
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'the retry never produced a picture',
      })
      const respawned = await diffusionStatus(dataFolder)
      expect(respawned.model.state).toBe('loaded')
      expect(respawned.model.loaded?.pid).not.toBe(pid)
      expect(await sdPids(engine)).toEqual([pid, respawned.model.loaded?.pid])
      expect(liveFakeSdServers(dataFolder)).toEqual([respawned.model.loaded?.pid])
    })
  })
})
