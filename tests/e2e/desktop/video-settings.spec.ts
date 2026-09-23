/**
 * Settings → Media: the video folder moved to one the user picks (through
 * the native folder dialog the e2e build answers), the next clip put there,
 * and the choice kept across a restart; and a clip deleted from the viewer
 * after the confirmation, gone from disk with its recipe and poster.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerNextDialog } from '../harness/fixtures.js'
import { diffusionStatus, IMAGE_BACKEND_ID } from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'
import {
  generateVideo,
  installFakeVideoEngine,
  loadVideoModel,
  openVideos,
  posterRendered,
  VIDEO_ENGINE_TAG,
  videoGalleryOnDisk,
  videoSeed,
  videoTiles,
  writeFakeVideoModel,
} from '../harness/videos.js'

async function openMediaSettings(session: Session): Promise<void> {
  const browser = session.app.browser
  await browser.$('//*[normalize-space(text())="Settings"]').click()
  const media = browser.$('//a[normalize-space(.)="Media"]')
  await media.waitForClickable({ timeout: 30_000 })
  await media.click()
  await browser.$('[data-testid="media-settings-panel"]').waitForDisplayed({ timeout: 30_000 })
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the video folder and the gallery', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('video-settings', {
      webviewSeed: videoSeed({ form: { frames: 9, steps: 2 } }),
      imageEngines: [`${VIDEO_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeVideoEngine(profile)
        await writeFakeVideoModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('moves the video gallery to a folder the user picks, puts the next clip there, and keeps the choice across a restart', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const defaultDir = join(dataFolder, 'videos')
      const chosen = join(session.profile.home, 'Movies', 'Atomic')
      await mkdir(chosen, { recursive: true })

      await openMediaSettings(session)
      expect(await browser.$('[data-testid="media-video-output-dir"]').getText()).toBe(defaultDir)
      // The image folder is its own row and stays where it was.
      expect(await browser.$('[data-testid="media-output-dir"]').getText()).toBe(join(dataFolder, 'images'))
      await answerNextDialog(session.profile, chosen)
      await browser.$('[aria-label="Change the video folder"]').click()
      await browser.waitUntil(async () => (await diffusionStatus(dataFolder)).videoOutputDir === chosen, {
        timeout: 15_000,
        timeoutMsg: 'the core was not told the new video folder',
      })
      expect(await browser.$('[data-testid="media-video-output-dir"]').getText()).toBe(chosen)
      expect((await diffusionStatus(dataFolder)).outputDir).toBe(join(dataFolder, 'images'))

      await openVideos(session)
      await loadVideoModel(session)
      await generateVideo(session, 'a boat in the new folder')
      await browser.waitUntil(async () => (await videoTiles(session)).length === 1, { timeout: 90_000 })
      const [tileId] = await videoTiles(session)
      await browser.waitUntil(async () => posterRendered(session, tileId as string), { timeout: 30_000 })
      expect(await videoGalleryOnDisk(chosen)).toHaveLength(1)
      expect(await videoGalleryOnDisk(defaultDir)).toEqual([])

      await restartApp(session)
      const relaunched = session.app.browser
      await openMediaSettings(session)
      expect(await relaunched.$('[data-testid="media-video-output-dir"]').getText()).toBe(chosen)
      await expect.poll(async () => (await diffusionStatus(dataFolder)).videoOutputDir, { timeout: 30_000 }).toBe(chosen)
      await openVideos(session)
      await relaunched.waitUntil(async () => (await videoTiles(session)).length === 1, { timeout: 60_000 })
    })
  }, 300_000)

  it('deletes a clip from the viewer after asking', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const chosen = join(session.profile.home, 'Movies', 'Atomic')
      const [tileId] = await videoTiles(session)
      expect(tileId).toBeDefined()
      const before = (await readdir(chosen)).filter((name) => name.startsWith(tileId as string)).sort()
      expect(before).toEqual([`${tileId}.json`, `${tileId}.thumb.png`, `${tileId}.webm`])

      await browser.$(`[data-testid="video-tile-${tileId}"]`).click()
      await browser.$('[data-testid="video-viewer-delete"]').waitForClickable({ timeout: 15_000 })
      await browser.$('[data-testid="video-viewer-delete"]').click()
      await browser.$('[data-testid="gallery-delete-confirm"]').waitForClickable({ timeout: 15_000 })
      await browser.$('[data-testid="gallery-delete-confirm"]').click()

      await browser.waitUntil(async () => (await videoTiles(session)).length === 0, { timeout: 30_000 })
      for (const name of before) expect(await stat(join(chosen, name)).catch(() => null)).toBeNull()
      expect(await videoGalleryOnDisk(chosen)).toEqual([])
    })
  }, 120_000)
})
