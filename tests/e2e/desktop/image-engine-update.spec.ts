/**
 * The image engine's lifecycle from the page: a model the installed engine is
 * too old for is refused with the update offer, the update is downloaded from
 * a release published on this machine, unpacked, finalized by the core, the
 * old tree retired, and the model loaded on the new one; and a model that is
 * not on disk is downloaded from a Hugging Face published the same way.
 *
 * Neither address can be changed in the app, so both are reached the way a
 * corporate network reaches them: through the user's proxy setting, a CONNECT
 * proxy on loopback that leads every host to one local origin (harness/image-mirror.ts).
 */
import { mkdtemp, readdir, readFile, rm, stat } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { proxySeed } from '../harness/backend-mirror.js'
import { buildImageEngineArchive, startImageMirror, type ImageMirror } from '../harness/image-mirror.js'
import {
  diffusionStatus,
  galleryTiles,
  GATED_ARTIFACT,
  generate,
  IMAGE_ARTIFACT,
  IMAGE_BACKEND_ID,
  IMAGE_ENGINE_ASSET,
  imageCatalogFixture,
  imageSeed,
  installedImageEngines,
  installFakeImageEngine,
  liveFakeSdServers,
  loadImageModel,
  OLD_IMAGE_ENGINE_TAG,
  openImages,
  sdPids,
  writeFakeImageModel,
} from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

/** A build the seeded manifest publishes, newer than 883 so Qwen Image 2.1 runs on it. */
const NEW_TAG = 'master-900-e2e0001'
const RUNTIME = '[data-testid="image-model-runtime-indicator"], [data-testid="image-model-runtime-action"]'
const BANNER = '[data-testid="image-error-banner"]'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('updating the image engine', () => {
  let session: Session
  let mirror: ImageMirror
  let work: string
  let newPids = ''
  let newArgv = ''

  beforeAll(async () => {
    work = await mkdtemp(join(tmpdir(), 'atomic-image-engine-e2e-'))
    session = await startSession('image-engine-update', {
      imageEngines: [`${OLD_IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`, `${NEW_TAG}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        // What is installed: the build app v2.0.40 shipped, on which Qwen Image 2.1 is refused.
        await installFakeImageEngine(profile, { tag: OLD_IMAGE_ENGINE_TAG })
        await writeFakeImageModel(profile, GATED_ARTIFACT)
        // What the manifest publishes: a newer build, as the release archive the app unpacks.
        newPids = join(profile.root, 'sd-pids-new')
        newArgv = join(profile.root, 'sd-argv-new.json')
        const archive = await buildImageEngineArchive(work, { name: IMAGE_ENGINE_ASSET, pidFile: newPids, argvFile: newArgv })
        mirror = await startImageMirror({
          [`/leejet/stable-diffusion.cpp/releases/download/${NEW_TAG}/${IMAGE_ENGINE_ASSET}`]: await readFile(archive.path),
        })
        // The seed cannot be passed after the profile exists, so the session's own seed is
        // written here, on top of what `createProfile` wrote.
        const seedPath = join(profile.root, 'webview-seed.json')
        const seed = JSON.parse(await readFile(seedPath, 'utf8')) as Record<string, string>
        Object.assign(
          seed,
          imageSeed({
            selected: GATED_ARTIFACT,
            manifestTag: NEW_TAG,
            manifestAsset: { name: archive.name, sha256: archive.sha256, size: archive.size },
          }),
          proxySeed(mirror.proxyUrl)
        )
        const { writeFile } = await import('node:fs/promises')
        await writeFile(seedPath, JSON.stringify(seed))
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await mirror?.stop()
    await rm(work, { recursive: true, force: true })
    expect(left).toEqual([])
  })

  it('refuses a model the installed engine is too old for, updates the engine from a release published on this machine, and loads the model on it', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const backends = join(dataFolder, 'diffusion', 'backends')

      await openImages(session)
      expect((await diffusionStatus(dataFolder)).install).toMatchObject({ state: 'installed', tag: OLD_IMAGE_ENGINE_TAG })
      // Run: refused before anything is spawned, with the one action that helps.
      await browser.waitUntil(async () => (await browser.$(RUNTIME).getAttribute('data-phase')) === 'idle', { timeout: 30_000 })
      await browser.$(RUNTIME).click()
      await browser.$(BANNER).waitForDisplayed({ timeout: 30_000 })
      expect(await browser.$(BANNER).getText()).toContain('Image engine update required')
      expect((await diffusionStatus(dataFolder)).model.state).not.toBe('loaded')
      expect(liveFakeSdServers(dataFolder)).toEqual([])
      const update = browser.$(BANNER).$('button=Update engine and retry')
      await update.waitForClickable({ timeout: 15_000 })
      await update.click()

      // The download, the unpack, the finalize and the load the page runs on its own.
      await browser.waitUntil(async () => (await browser.$(RUNTIME).getAttribute('data-phase')) === 'ready', {
        timeout: 120_000,
        timeoutMsg: 'the model never loaded on the updated engine',
      })
      const seen = mirror.seen()
      expect(seen).toContain('CONNECT github.com:443')
      expect(seen.some((line) => line.includes(`/leejet/stable-diffusion.cpp/releases/download/${NEW_TAG}/${IMAGE_ENGINE_ASSET}`))).toBe(true)
      // The new tree, owned and recorded; the old one retired; no archive left in staging.
      const newDir = join(backends, NEW_TAG, IMAGE_BACKEND_ID)
      expect((await stat(join(newDir, '.atomic-owned'))).isFile()).toBe(true)
      expect((await stat(join(newDir, 'sd-server'))).mode & 0o111).not.toBe(0)
      expect(JSON.parse(await readFile(join(newDir, 'install.json'), 'utf8'))).toMatchObject({
        tag: NEW_TAG,
        backendId: IMAGE_BACKEND_ID,
        engine: 'sd-cpp',
      })
      expect(await installedImageEngines(dataFolder)).toEqual([`${NEW_TAG}/${IMAGE_BACKEND_ID}`])
      expect(await readdir(join(backends, 'tmp')).catch(() => [])).toEqual([])
      const status = await diffusionStatus(dataFolder)
      expect(status.install).toMatchObject({ tag: NEW_TAG, dir: newDir })
      expect(status.model.loaded?.modelId).toBe(GATED_ARTIFACT)
      // It is the new engine that runs: its own pid file has the process.
      expect(await sdPids({ pidFile: newPids })).toEqual([status.model.loaded?.pid])
      expect(JSON.parse(await readFile(newArgv, 'utf8')) as string[]).toContain('--llm')
      expect(await browser.$(BANNER).isExisting()).toBe(false)

      await generate(session, 'a cube on the new engine')
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 90_000,
        timeoutMsg: 'no picture from the updated engine',
      })
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('downloading an image model', () => {
  let session: Session
  let mirror: ImageMirror
  const family = imageCatalogFixture().families[0]!
  const quant = family.transformer.quants[0]!
  const files: Record<string, Buffer> = {}

  beforeAll(async () => {
    // Every file the catalog names for Z-Image, at exactly its byte count, on a Hugging Face of ours.
    files[`/${family.transformer.repo}/resolve/main/${quant.filename}`] = Buffer.alloc(quant.bytes, 0x5a)
    if (family.vae) files[`/${family.vae.repo}/resolve/main/${family.vae.filename}`] = Buffer.alloc(family.vae.bytes, 0x56)
    for (const encoder of family.text_encoders)
      files[`/${encoder.repo}/resolve/main/${encoder.filename}`] = Buffer.alloc(encoder.bytes, 0x54)
    mirror = await startImageMirror(files)
    session = await startSession('image-model-download', {
      webviewSeed: { ...imageSeed({ selected: null }), ...proxySeed(mirror.proxyUrl) },
      imageEngines: [`${'master-900-e2e0001'}/${IMAGE_BACKEND_ID}`],
      prepare: async (profile) => {
        await installFakeImageEngine(profile)
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await mirror?.stop()
    expect(left).toEqual([])
  })

  it('downloads a model from the picker and offers it as ready to run', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      await openImages(session)
      await browser.$('[data-testid="image-models-toggle"]').click()
      // The available family's row carries the recommended quant and its Download button.
      const download = browser.$(`[data-testid="artifact-${IMAGE_ARTIFACT}"]`).$('button=Download')
      await download.waitForClickable({ timeout: 30_000 })
      await download.click()

      // Every file lands at the catalog's size; no token travelled to "Hugging Face".
      const models = join(dataFolder, 'diffusion', 'models')
      const expected = [
        [join(models, family.id, quant.filename), quant.bytes],
        ...(family.vae ? [[join(models, 'shared', family.vae.repo.replace('/', '--'), family.vae.filename), family.vae.bytes]] : []),
        ...family.text_encoders.map((e) => [join(models, 'shared', e.repo.replace('/', '--'), e.filename), e.bytes]),
      ] as Array<[string, number]>
      await browser.waitUntil(
        async () => {
          for (const [path, bytes] of expected) if ((await stat(path).catch(() => null))?.size !== bytes) return false
          return true
        },
        { timeout: 120_000, timeoutMsg: `the model files did not arrive: ${JSON.stringify(mirror.seen())}` }
      )
      const seen = mirror.seen()
      expect(seen.some((line) => line.startsWith('CONNECT huggingface.co:443'))).toBe(true)
      for (const path of Object.keys(files)) expect(seen.some((line) => line.includes(path))).toBe(true)
      expect(seen.some((line) => line.includes('(with authorization)'))).toBe(false)

      // Downloaded, selected, and runnable from the same control.
      await browser.keys('Escape')
      await loadImageModel(session, 90_000)
      expect((await diffusionStatus(dataFolder)).model.loaded?.modelId).toBe(IMAGE_ARTIFACT)
    })
  }, 300_000)
})
