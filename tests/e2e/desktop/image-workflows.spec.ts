/**
 * A workflow that starts from a picture: Transform with a source chosen on
 * disk through the native file dialog (answered by the e2e build), then with a
 * picture taken from the gallery. Both requests reach the core with the source
 * named, and both pictures land in the gallery.
 */
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { pageShows } from '../harness/chat.js'
import { coreRequest } from '../harness/core.js'
import { answerNextDialog } from '../harness/fixtures.js'
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
  writeSourcePng,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

async function jobRequest(dataFolder: string, id: string): Promise<{ workflow?: string; initImage?: { path?: string; base64?: string } }> {
  const res = await coreRequest(dataFolder, `/diffusion/jobs/${id}`)
  return ((await res.json()) as { job: { request: { workflow?: string; initImage?: { path?: string } } } }).job.request
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('transforming a picture', () => {
  let session: Session
  let source = ''

  beforeAll(async () => {
    session = await startSession('image-workflows', {
      webviewSeed: imageSeed(),
      imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeImageEngine(profile)
        await writeFakeImageModel(profile)
        source = join(profile.home, 'Pictures', 'source.png')
        await writeSourcePng(source, 320, 256)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('transforms a picture chosen from disk and a picture taken from the gallery', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      await openImages(session, 'transform')
      expect(await browser.$('[data-testid="image-workflow-title"]').getText()).toContain('Transform')
      await loadImageModel(session)
      // Without a source there is nothing to transform.
      expect(await browser.$('[data-testid="image-generate"]').isEnabled()).toBe(false)

      // The file dialog is answered by the build with the path queued here; the picture shows once read.
      await answerNextDialog(session.profile, source)
      await browser.$('[data-testid="image-source-dropzone"]').click()
      await browser.$('[data-testid="image-source-dropzone"] img').waitForDisplayed({ timeout: 15_000 })
      await pageShows(session, '320×256', 15_000)
      await generate(session, 'the same scene as a painting')
      const first = await browser.waitUntil(async () => (await diffusionStatus(dataFolder)).activeJob?.id, {
        timeout: 15_000,
        timeoutMsg: 'the job never started',
      })
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, { timeout: 90_000 })
      expect(await jobRequest(dataFolder, first as string)).toMatchObject({ workflow: 'transform', initImage: { path: source } })

      // Now from the gallery: the picture just made becomes the source of the next.
      await browser.$('[data-testid="image-source-dropzone-gallery"]').click()
      const picker = browser.$('[data-testid="image-gallery-picker"]')
      await picker.waitForDisplayed({ timeout: 15_000 })
      await picker.$('[data-testid^="gallery-tile-"]').click()
      await browser.waitUntil(async () => !(await picker.isExisting()) || !(await picker.isDisplayed()), { timeout: 15_000 })
      await generate(session, 'and again, as a sketch')
      const second = await browser.waitUntil(async () => {
        const id = (await diffusionStatus(dataFolder)).activeJob?.id
        return id && id !== first ? id : undefined
      }, { timeout: 15_000, timeoutMsg: 'the second job never started' })
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 2, { timeout: 90_000 })
      const request = await jobRequest(dataFolder, second as string)
      expect(request.workflow).toBe('transform')
      expect(request.initImage?.path?.startsWith(join(dataFolder, 'images'))).toBe(true)
    })
  }, 300_000)
})
