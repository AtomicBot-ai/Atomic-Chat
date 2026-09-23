/**
 * Settings → Media: the output folder moved to one the user picks (through
 * the native folder dialog the e2e build answers), the next picture put there,
 * and the choice kept across a restart; and a picture deleted from the viewer
 * after the confirmation, gone from disk with its thumbnail.
 */
import { mkdir, readdir, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { answerNextDialog } from '../harness/fixtures.js'
import {
  diffusionStatus,
  galleryOnDisk,
  galleryTiles,
  generate,
  IMAGE_BACKEND_ID,
  IMAGE_ENGINE_TAG,
  imageSeed,
  installFakeImageEngine,
  loadImageModel,
  openImages,
  tileRendered,
  writeFakeImageModel,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'

async function openMediaSettings(session: Session): Promise<void> {
  const browser = session.app.browser
  await browser.$('//*[normalize-space(text())="Settings"]').click()
  const media = browser.$('//a[normalize-space(.)="Media"]')
  await media.waitForClickable({ timeout: 30_000 })
  await media.click()
  await browser.$('[data-testid="media-settings-panel"]').waitForDisplayed({ timeout: 30_000 })
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the output folder and the gallery', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('image-settings', {
      webviewSeed: imageSeed(),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeImageEngine(profile)
        await writeFakeImageModel(profile)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('moves the gallery to a folder the user picks, puts the next picture there, and keeps the choice across a restart', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const defaultDir = join(dataFolder, 'images')
      const chosen = join(session.profile.home, 'Pictures', 'Atomic')
      await mkdir(chosen, { recursive: true })

      await openMediaSettings(session)
      expect(await browser.$('[data-testid="media-output-dir"]').getText()).toBe(defaultDir)
      await answerNextDialog(session.profile, chosen)
      await browser.$('button=Change…').click()
      await browser.waitUntil(async () => (await diffusionStatus(dataFolder)).outputDir === chosen, {
        timeout: 15_000,
        timeoutMsg: 'the core was not told the new folder',
      })
      expect(await browser.$('[data-testid="media-output-dir"]').getText()).toBe(chosen)

      await openImages(session)
      await loadImageModel(session)
      await generate(session, 'a cube in the new folder')
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, { timeout: 90_000 })
      const [tileId] = await galleryTiles(session)
      expect(await tileRendered(session, tileId as string)).toBe(true)
      expect(await galleryOnDisk(chosen)).toHaveLength(1)
      expect(await galleryOnDisk(defaultDir)).toEqual([])

      await restartApp(session)
      const relaunched = session.app.browser
      await openMediaSettings(session)
      expect(await relaunched.$('[data-testid="media-output-dir"]').getText()).toBe(chosen)
      await expect.poll(async () => (await diffusionStatus(dataFolder)).outputDir, { timeout: 30_000 }).toBe(chosen)
      await openImages(session)
      await relaunched.waitUntil(async () => (await galleryTiles(session)).length === 1, { timeout: 60_000 })
    })
  }, 300_000)

  it('deletes a picture from the viewer after asking', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const chosen = join(session.profile.home, 'Pictures', 'Atomic')
      const [tileId] = await galleryTiles(session)
      expect(tileId).toBeDefined()
      const [pngName] = await galleryOnDisk(chosen)
      const png = join(chosen, pngName as string)
      const thumbnails = (await readdir(chosen)).filter((name) => name.endsWith('.thumb.png'))
      expect(thumbnails).toHaveLength(1)

      await browser.$(`[data-testid="gallery-tile-${tileId}"]`).click()
      await browser.$('[data-testid="image-viewer-delete"]').waitForClickable({ timeout: 15_000 })
      await browser.$('[data-testid="image-viewer-delete"]').click()
      await browser.$('[data-testid="gallery-delete-confirm"]').waitForClickable({ timeout: 15_000 })
      await browser.$('[data-testid="gallery-delete-confirm"]').click()

      await browser.waitUntil(async () => (await galleryTiles(session)).length === 0, { timeout: 30_000 })
      expect(await stat(png).catch(() => null)).toBeNull()
      expect(await stat(join(chosen, thumbnails[0] as string)).catch(() => null)).toBeNull()
      expect(await galleryOnDisk(chosen)).toEqual([])
    })
  }, 120_000)
})
