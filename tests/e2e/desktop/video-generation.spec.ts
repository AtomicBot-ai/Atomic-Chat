/**
 * The Video page on the core: a video checkpoint run through the core's
 * engine in its video mode, a clip generated with progress, shown as a tile
 * with the poster the app rendered and played in the viewer, on disk as a
 * WebM with its recipe sidecar and the poster, and still there after a
 * restart with nothing loaded.
 *
 * The engine is the core's scripted `sd-server` with `vid_gen` advertised,
 * the model a few bytes of the size the catalog says, the catalog and
 * manifest seeded into the webview's cache — see harness/videos.ts.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSessions } from '../harness/chat.js'
import { diffusionStatus, IMAGE_BACKEND_ID, liveFakeSdServers, sdArgv, type FakeImageEngine } from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'
import {
  generateVideo,
  installFakeVideoEngine,
  loadVideoModel,
  openVideos,
  posterRendered,
  VIDEO_ARTIFACT,
  VIDEO_ENGINE_TAG,
  videoGalleryOnDisk,
  videoPostersOnDisk,
  videoRendered,
  videoSeed,
  videoTiles,
  writeFakeVideoModel,
} from '../harness/videos.js'

const PROMPT = 'a paper boat drifting across a moonlit lake, e2e 7b2e'
/** EBML: what every WebM starts with. */
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('generating a clip on the core', () => {
  let session: Session
  let engine: FakeImageEngine
  let modelFiles: string[] = []

  beforeAll(async () => {
    session = await startSession('video-generation', {
      webviewSeed: videoSeed({ form: { frames: 9, steps: 2 } }),
      imageEngines: [`${VIDEO_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        engine = await installFakeVideoEngine(profile)
        modelFiles = await writeFakeVideoModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('loads the video model through the core, generates a clip, shows it with its poster and plays it, and keeps it across a restart', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await openVideos(session)
      // The engine is installed and the tour was done: the studio, not the setup card.
      expect(await browser.$('[data-testid="video-prompt-form"]').isDisplayed()).toBe(true)
      expect(await browser.$('[data-testid="video-onboarding"]').isExisting()).toBe(false)
      expect(await browser.$('[data-testid="image-generate"]').isEnabled()).toBe(false)
      expect(await browser.$('[data-testid="video-frame-rate"]').getText()).toBe('24 fps')

      await loadVideoModel(session)
      const loaded = await diffusionStatus(dataFolder)
      expect(loaded.model.state).toBe('loaded')
      expect(loaded.model.loaded?.modelId).toBe(VIDEO_ARTIFACT)
      expect(loaded.model.loaded?.modality).toBe('video')
      expect(loaded.videoOutputDir).toBe(join(dataFolder, 'videos'))
      const pid = loaded.model.loaded?.pid as number
      expect(liveFakeSdServers(dataFolder)).toEqual([pid])
      expect(await coreSessions(dataFolder)).toEqual([])
      // The argv the core built from the catalog: transformer, both VAEs, the LLM and the connectors.
      const argv = await sdArgv(engine)
      for (const file of modelFiles) expect(argv).toContain(file)
      expect(argv).toContain('--audio-vae')
      expect(argv).toContain('--embeddings-connectors')

      await generateVideo(session, PROMPT)
      await browser.waitUntil(async () => (await videoTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'no clip arrived in the gallery',
      })
      await browser.$('[data-testid="image-generate"]').waitForDisplayed({ timeout: 15_000 })
      const [tileId] = await videoTiles(session)
      expect(await browser.$('[data-testid="image-error-banner"]').isExisting()).toBe(false)

      // The webview rendered the poster and the core stored it; the tile shows it.
      const videos = join(dataFolder, 'videos')
      await browser.waitUntil(async () => posterRendered(session, tileId as string), {
        timeout: 30_000,
        timeoutMsg: 'the tile never showed its poster',
      })
      expect(await videoPostersOnDisk(videos)).toEqual([`${tileId}.thumb.png`])
      const poster = await readFile(join(videos, `${tileId}.thumb.png`))
      expect(poster.subarray(0, 8)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47, 0x0d, 0x0a, 0x1a, 0x0a]))

      // The viewer plays the clip itself: metadata read and a frame size, over the asset protocol.
      expect(await browser.$('[data-testid="video-viewer"]').isDisplayed()).toBe(true)
      await browser.waitUntil(() => videoRendered(session), {
        timeout: 30_000,
        timeoutMsg: 'the player never decoded the clip',
      })
      expect(await browser.$('[data-testid="video-playback-unsupported"]').isExisting()).toBe(false)

      // The recipe: the frames the engine wrote at the family's rate.
      await browser.$('[data-testid="video-recipe-trigger"]').click()
      await browser.$('[data-testid="video-recipe-restore"]').waitForDisplayed({ timeout: 15_000 })
      expect(await browser.$('//dd[normalize-space(.)="9 @ 24 fps"]').isExisting()).toBe(true)
      await browser.keys('Escape')

      // On disk: one WebM with its JSON sidecar, in the default folder.
      expect(await videoGalleryOnDisk(videos)).toEqual([`${tileId}.webm`])
      const webm = await readFile(join(videos, `${tileId}.webm`))
      expect(webm.subarray(0, 4)).toEqual(WEBM_MAGIC)
      const recipe = JSON.parse(await readFile(join(videos, `${tileId}.json`), 'utf8')) as {
        prompt: string
        frames: number
        fps: number
        model: { modelId: string }
      }
      expect(recipe).toMatchObject({ prompt: PROMPT, frames: 9, fps: 24, model: { modelId: VIDEO_ARTIFACT } })
      const status = await diffusionStatus(dataFolder)
      expect(status.activeVideoJob).toBeNull()
      expect(status.model.loaded?.pid).toBe(pid)

      // After a full restart the clip is still in the gallery and the viewer; nothing is loaded.
      await restartApp(session)
      const relaunched = session.app.browser
      await openVideos(session)
      await relaunched.waitUntil(async () => (await videoTiles(session)).length === 1, {
        timeout: 60_000,
        timeoutMsg: 'the gallery did not come back after the restart',
      })
      expect(await videoTiles(session)).toEqual([tileId])
      expect(await posterRendered(session, tileId as string)).toBe(true)
      expect(await relaunched.$('[data-testid="video-viewer"]').isDisplayed()).toBe(true)
      expect(liveFakeSdServers(dataFolder)).toEqual([])
      expect((await diffusionStatus(dataFolder)).model.state).toBe('unloaded')
    })
  }, 300_000)
})
