/**
 * The image endpoint for outside clients: Settings → Media shows where it is
 * and how to call it; an OpenAI-style client gets a picture through the local
 * API with the same key gate as chat; and the picture it made shows up in the
 * app's gallery without a restart. An image-only user — no chat model at all —
 * gets the server that serves it: with the image model when auto-start is on,
 * from "Start server" or from the Images page's own card when it is off.
 */
import { stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreRequest } from '../harness/core.js'
import {
  diffusionStatus,
  galleryTiles,
  IMAGE_ARTIFACT,
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

const LOCAL_API_KEY = 'e2e-images-api-key'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the image endpoint for outside clients', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('image-api', {
      apiServer: { apiKey: LOCAL_API_KEY },
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

  it("makes a picture for an outside client of /v1/images/generations and shows it in the app's gallery", async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder
      const endpoint = `http://127.0.0.1:${session.apiPort}/v1/images/generations`

      // Settings → Media names the endpoint and gives a curl for it.
      await browser.$('//*[normalize-space(text())="Settings"]').click()
      const media = browser.$('//a[normalize-space(.)="Media"]')
      await media.waitForClickable({ timeout: 30_000 })
      await media.click()
      await browser.$('[data-testid="image-api-settings-card"]').waitForDisplayed({ timeout: 30_000 })
      expect(await browser.$('[data-testid="image-api-endpoint"]').getText()).toContain('/v1/images/generations')
      expect(await browser.$('[data-testid="image-api-endpoint"]').getText()).toContain(String(session.apiPort))
      expect(await browser.$('[data-testid="image-api-curl"]').getText()).toContain('/v1/images/generations')

      // The listener up, as an API user would have it, and nothing loaded yet: 503 in OpenAI's shape.
      const started = await coreRequest(dataFolder, '/server/start', {
        method: 'POST',
        headers: { 'content-type': 'application/json' },
        body: JSON.stringify({ port: session.apiPort, api_key: LOCAL_API_KEY }),
      })
      expect(started.status, await started.clone().text()).toBe(200)
      const call = (body: unknown, key: string | null = LOCAL_API_KEY) =>
        fetch(endpoint, {
          method: 'POST',
          headers: { 'content-type': 'application/json', ...(key ? { authorization: `Bearer ${key}` } : {}) },
          body: JSON.stringify(body),
        })
      const notLoaded = await call({ prompt: 'a cube' })
      expect(notLoaded.status).toBe(503)
      expect(await notLoaded.json()).toMatchObject({ error: { code: 'model_not_loaded' } })
      expect((await call({ prompt: 'a cube' }, null)).status).toBe(401)

      // The model loaded from the page; the client's picture comes back and lands in the gallery.
      await openImages(session)
      await loadImageModel(session)
      expect(await galleryTiles(session)).toEqual([])
      const made = await call({ prompt: 'a cube for an outside client', n: 1, seed: 5, size: '256x256' })
      expect(made.status, await made.clone().text()).toBe(200)
      const answer = (await made.json()) as { data: Array<{ b64_json: string }>; atomic: { job_id: string; seed: number; paths: string[] } }
      expect(Buffer.from(answer.data[0]?.b64_json ?? '', 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
      expect(answer.atomic.seed).toBe(5)
      expect(answer.atomic.paths[0]?.startsWith(join(dataFolder, 'images'))).toBe(true)
      expect((await stat(answer.atomic.paths[0] as string)).size).toBeGreaterThan(0)
      // Image models are not chat models: the listing does not offer them.
      const models = await fetch(`http://127.0.0.1:${session.apiPort}/v1/models`, { headers: { authorization: `Bearer ${LOCAL_API_KEY}` } })
      expect(JSON.stringify(await models.json())).not.toContain(IMAGE_ARTIFACT)
      // Without a restart: the job's event reached the page.
      await browser.waitUntil(async () => (await galleryTiles(session)).length === 1, {
        timeout: 30_000,
        timeoutMsg: "the outside client's picture did not reach the gallery",
      })
      expect((await diffusionStatus(dataFolder)).activeJob).toBeNull()
    })
  }, 300_000)
})

/** Resolves once the profile's Local API Server accepts connections. */
async function serverListening(session: Session): Promise<void> {
  await session.app.browser.waitUntil(
    async () => {
      try {
        await fetch(`http://127.0.0.1:${session.apiPort}/v1/models`)
        return true
      } catch {
        return false
      }
    },
    { timeout: 60_000, timeoutMsg: 'the Local API Server never came up' }
  )
}

/** A picture requested the way an outside client would, answered as PNG bytes. */
async function expectPicture(session: Session, prompt: string): Promise<void> {
  const made = await fetch(`http://127.0.0.1:${session.apiPort}/v1/images/generations`, {
    method: 'POST',
    headers: { 'content-type': 'application/json', authorization: `Bearer ${LOCAL_API_KEY}` },
    body: JSON.stringify({ prompt, n: 1, seed: 3, size: '256x256' }),
  })
  expect(made.status, await made.clone().text()).toBe(200)
  const answer = (await made.json()) as { data: Array<{ b64_json: string }> }
  expect(Buffer.from(answer.data[0]?.b64_json ?? '', 'base64').subarray(0, 4)).toEqual(Buffer.from([0x89, 0x50, 0x4e, 0x47]))
}

function imageOnlySession(name: string, apiServer: Record<string, unknown>): Promise<Session> {
  return startSession(name, {
    apiServer: { apiKey: LOCAL_API_KEY, ...apiServer },
    webviewSeed: imageSeed(),
    imageEngines: [`${IMAGE_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
    prepare: async (profile) => {
      await installFakeImageEngine(profile)
      await writeFakeImageModel(profile)
    },
  })
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the image endpoint for an image-only user, auto-start on', () => {
  let session: Session

  beforeAll(async () => {
    session = await imageOnlySession('image-api-auto-start', { enableOnStartup: true })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('brings the Local API Server up with the image model', async () => {
    await withArtifacts(session, async () => {
      await openImages(session)
      // Auto-start raises the server for a running model, and nothing runs yet.
      await expect(fetch(`http://127.0.0.1:${session.apiPort}/v1/models`)).rejects.toThrow()

      await loadImageModel(session)
      await serverListening(session)
      await expectPicture(session, 'a cube for a client of the auto-started server')
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the image endpoint for an image-only user, auto-start off', () => {
  let session: Session

  beforeAll(async () => {
    session = await imageOnlySession('image-api-start', {})
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('starts the server with no chat model, from the API screen and from the Images page', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const models = `http://127.0.0.1:${session.apiPort}/v1/models`

      await openImages(session)
      await loadImageModel(session)
      // Auto-start is off: the model is resident and nothing listens.
      await expect(fetch(models)).rejects.toThrow()

      // "Start server" used to load a chat model first; with none on disk it never started.
      await browser.$('a=API').click()
      await browser.$('button=Start server').click()
      await browser.$('button=Stop server').waitForDisplayed({ timeout: 60_000 })
      await expectPicture(session, 'a cube for a client of the API screen')
      await browser.$('button=Stop server').click()
      await browser.$('button=Start server').waitForDisplayed({ timeout: 30_000 })
      await expect(fetch(models)).rejects.toThrow()

      // The Images page's own card says the server is down and brings it up in place.
      await openImages(session)
      await browser.$('[data-testid="image-advanced-toggle"]').click()
      const stopped = browser.$('[data-testid="image-api-server-stopped"]')
      await stopped.waitForDisplayed({ timeout: 30_000 })
      await browser.$('[data-testid="image-api-start-server"]').click()
      await stopped.waitForDisplayed({ reverse: true, timeout: 60_000 })
      await expectPicture(session, 'a cube for a client of the Images page')

      // Neither start loaded anything beside the image model, and it is still the one resident.
      expect((await diffusionStatus(session.profile.dataFolder)).model.state).toBe('loaded')
    })
  }, 300_000)
})
