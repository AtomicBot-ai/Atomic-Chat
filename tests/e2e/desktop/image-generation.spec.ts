/**
 * The Images page on the core: a checkpoint run through the core's image
 * engine, a picture generated with progress, shown in the gallery and the
 * viewer, on disk with its recipe, and still there after a restart; and a
 * generation stopped halfway, which leaves nothing behind and keeps the engine.
 *
 * The engine is the core's scripted `sd-server`, the model a few bytes of the
 * size the catalog says, the catalog and manifest seeded into the webview's
 * cache — see harness/images.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSessions, pageShows } from '../harness/chat.js'
import {
  diffusionJob,
  diffusionStatus,
  galleryOnDisk,
  galleryTiles,
  generate,
  IMAGE_ARTIFACT,
  IMAGE_BACKEND_ID,
  IMAGE_ENGINE_TAG,
  imageSeed,
  installFakeImageEngine,
  liveFakeSdServers,
  loadImageModel,
  openImages,
  sdArgv,
  tileRendered,
  writeFakeImageModel,
  type FakeImageEngine,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'

const PROMPT = 'a red cube on a white table, e2e 4f1c'

async function journalledDiffusion(dataFolder: string): Promise<Array<{ pid: number; provider: string; model_id: string }>> {
  const journal = JSON.parse(await readFile(join(dataFolder, 'atomic-core', 'processes.json'), 'utf8').catch(() => '{}')) as {
    processes?: Array<{ pid: number; provider: string; model_id: string }>
  }
  return (journal.processes ?? []).filter((p) => p.provider === 'diffusion')
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('generating a picture on the core', () => {
  let session: Session
  let engine: FakeImageEngine
  let modelFiles: string[] = []

  beforeAll(async () => {
    session = await startSession('image-generation', {
      webviewSeed: imageSeed(),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        engine = await installFakeImageEngine(profile)
        modelFiles = await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('loads the image model through the core, generates a picture, shows it in the gallery and the viewer, and keeps it across a restart', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await openImages(session)
      // The engine is installed and the tour was done: the studio, not the setup card.
      expect(await browser.$('[data-testid="image-prompt-form"]').isDisplayed()).toBe(true)
      expect(await browser.$('[data-testid="image-onboarding"]').isExisting()).toBe(false)
      expect(await browser.$('[data-testid="image-generate"]').isEnabled()).toBe(false)

      await loadImageModel(session)
      const loaded = await diffusionStatus(dataFolder)
      expect(loaded.model.state).toBe('loaded')
      expect(loaded.model.loaded?.modelId).toBe(IMAGE_ARTIFACT)
      expect(loaded.install).toMatchObject({ state: 'installed', tag: IMAGE_ENGINE_TAG, backendId: IMAGE_BACKEND_ID })
      const pid = loaded.model.loaded?.pid as number
      expect(liveFakeSdServers(dataFolder)).toEqual([pid])
      // The engine is the core's child, journalled under its own provider, and not a chat session.
      expect(await journalledDiffusion(dataFolder)).toEqual([expect.objectContaining({ pid, model_id: IMAGE_ARTIFACT })])
      expect(await coreSessions(dataFolder)).toEqual([])
      // The argv the core built from the catalog: transformer, VAE and text encoder, all three files.
      const argv = await sdArgv(engine)
      for (const file of modelFiles) expect(argv).toContain(file)
      expect(argv).toContain('--listen-ip')

      await generate(session, PROMPT)
      // Four steps of 150 ms: the picture is there before a progress bar would be worth watching.
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'no picture arrived in the gallery',
      })
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 15_000 })
      const [tileId] = await galleryTiles(session)
      expect(await tileRendered(session, tileId as string)).toBe(true)
      expect(await browser.$('[data-testid="image-viewer"]').isDisplayed()).toBe(true)
      expect(await browser.$('[data-testid="image-error-banner"]').isExisting()).toBe(false)

      // On disk: one PNG with the recipe inside, one thumbnail, in the default folder.
      const images = join(dataFolder, 'images')
      const [pngName] = await galleryOnDisk(images)
      expect(pngName).toBeDefined()
      const png = await readFile(join(images, pngName as string))
      expect(png.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))
      expect(png.indexOf(`tEXtparameters\0${PROMPT}`)).toBeGreaterThan(0)
      const status = await diffusionStatus(dataFolder)
      expect(status.activeJob).toBeNull()
      expect(status.model.loaded?.pid).toBe(pid)

      // After a full restart the picture is still in the gallery and the viewer; nothing is loaded.
      await restartApp(session)
      const relaunched = session.app.browser
      await openImages(session)
      await relaunched.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 60_000,
        timeoutMsg: 'the gallery did not come back after the restart',
      })
      expect(await galleryTiles(session)).toEqual([tileId])
      expect(await tileRendered(session, tileId as string)).toBe(true)
      expect(await relaunched.$('[data-testid="image-viewer"]').isDisplayed()).toBe(true)
      expect(liveFakeSdServers(dataFolder)).toEqual([])
      expect((await diffusionStatus(dataFolder)).model.state).toBe('unloaded')
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('stopping a generation', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('image-stop', {
      // Twenty slow steps: long enough to press Stop in the middle.
      webviewSeed: imageSeed({ form: { steps: 20 } }),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeImageEngine(profile, { stepMs: 400, cancel: true })
        await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('stops a generation: Generate comes back, nothing lands in the gallery, and the next picture is made by the same process', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await openImages(session)
      await loadImageModel(session)
      const pid = (await diffusionStatus(dataFolder)).model.loaded?.pid as number

      await generate(session, 'a long render')
      await browser.$('[data-testid="image-stop"]').waitForDisplayed({ timeout: 15_000 })
      const jobId = await browser.waitUntil(
        async () => (await diffusionStatus(dataFolder)).activeJob?.id,
        { timeout: 15_000, timeoutMsg: 'the job never started' }
      )
      await browser.$('[data-testid="image-stop"]').click()
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 30_000 })

      expect((await diffusionJob(dataFolder, jobId as string))?.state).toBe('cancelled')
      expect(await galleryTiles(session)).toEqual([])
      expect(await galleryOnDisk(join(dataFolder, 'images'))).toEqual([])
      // A stop the user asked for is not an error.
      expect(await browser.$('[data-testid="image-error-banner"]').isExisting()).toBe(false)
      // The engine honoured the cancel natively, so it is still the same process.
      expect((await diffusionStatus(dataFolder)).model.loaded?.pid).toBe(pid)

      await generate(session, 'a short one')
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'the next picture never arrived',
      })
      expect((await diffusionStatus(dataFolder)).model.loaded?.pid).toBe(pid)
      await pageShows(session, '1', 5_000)
    })
  })
})
