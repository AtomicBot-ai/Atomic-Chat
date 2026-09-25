/**
 * The video endpoint for outside clients on a video-only profile — no chat
 * model at all. `/v1/videos` lives on the Local API Server, which used to come
 * up only with a chat model: the server now comes up with the video model when
 * auto-start is on, and the Video page's own card starts it when it is off. A
 * client queues a clip, polls it to completion and downloads the WebM.
 */
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { diffusionStatus, IMAGE_BACKEND_ID } from '../harness/images.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'
import {
  installFakeVideoEngine,
  loadVideoModel,
  openVideos,
  VIDEO_ARTIFACT,
  VIDEO_ENGINE_TAG,
  videoSeed,
  writeFakeVideoModel,
} from '../harness/videos.js'

const LOCAL_API_KEY = 'e2e-videos-api-key'
/** EBML: what every WebM starts with. */
const WEBM_MAGIC = Buffer.from([0x1a, 0x45, 0xdf, 0xa3])

function videoOnlySession(name: string, apiServer: Record<string, unknown>): Promise<Session> {
  return startSession(name, {
    apiServer: { apiKey: LOCAL_API_KEY, ...apiServer },
    webviewSeed: videoSeed(),
    imageEngines: [`${VIDEO_ENGINE_TAG}/${IMAGE_BACKEND_ID}`],
    prepare: async (profile) => {
      await installFakeVideoEngine(profile)
      await writeFakeVideoModel(profile)
    },
  })
}

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

/** A clip requested the way an outside client would: queued, polled to completion, downloaded as WebM. */
async function expectClip(session: Session, prompt: string): Promise<void> {
  const base = `http://127.0.0.1:${session.apiPort}/v1/videos`
  const auth = { authorization: `Bearer ${LOCAL_API_KEY}` }
  // 0.4 s at the fixture's 24 fps snaps to its shortest clip, nine frames.
  const queued = await fetch(base, {
    method: 'POST',
    headers: { ...auth, 'content-type': 'application/json' },
    body: JSON.stringify({ prompt, seconds: 0.4 }),
  })
  expect(queued.status, await queued.clone().text()).toBe(200)
  const video = (await queued.json()) as { id: string; object: string; model: string }
  expect(video.object).toBe('video')
  expect(video.model).toBe(VIDEO_ARTIFACT)

  let status = ''
  await session.app.browser.waitUntil(
    async () => {
      const polled = (await (await fetch(`${base}/${video.id}`, { headers: auth })).json()) as { status: string }
      status = polled.status
      return status === 'completed' || status === 'failed'
    },
    { timeout: 90_000, timeoutMsg: 'the clip never finished' }
  )
  expect(status).toBe('completed')

  const content = await fetch(`${base}/${video.id}/content`, { headers: auth })
  expect(content.status).toBe(200)
  expect(content.headers.get('content-type')).toContain('video/webm')
  expect(Buffer.from(await content.arrayBuffer()).subarray(0, 4)).toEqual(WEBM_MAGIC)
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the video endpoint for a video-only user, auto-start on', () => {
  let session: Session

  beforeAll(async () => {
    session = await videoOnlySession('video-api-auto-start', { enableOnStartup: true })
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it('brings the Local API Server up with the video model', async () => {
    await withArtifacts(session, async () => {
      await openVideos(session)
      // Auto-start raises the server for a running model, and nothing runs yet.
      await expect(fetch(`http://127.0.0.1:${session.apiPort}/v1/models`)).rejects.toThrow()

      await loadVideoModel(session)
      await serverListening(session)
      await expectClip(session, 'a paper boat for a client of the auto-started server')
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('the video endpoint for a video-only user, auto-start off', () => {
  let session: Session

  beforeAll(async () => {
    session = await videoOnlySession('video-api-start', {})
  })

  afterAll(async () => {
    if (session) expect(await endSession(session)).toEqual([])
  })

  it("starts the server from the Video page's own card, loading no chat model", async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser

      await openVideos(session)
      await loadVideoModel(session)
      // Auto-start is off: the model is resident and nothing listens.
      await expect(fetch(`http://127.0.0.1:${session.apiPort}/v1/models`)).rejects.toThrow()

      await browser.$('[data-testid="video-advanced-toggle"]').click()
      const card = browser.$('[data-testid="image-api-settings-card"][data-resource="videos"]')
      await card.waitForDisplayed({ timeout: 30_000 })
      const stopped = card.$('[data-testid="image-api-server-stopped"]')
      await stopped.waitForDisplayed({ timeout: 30_000 })
      await card.$('[data-testid="image-api-start-server"]').click()
      await stopped.waitForDisplayed({ reverse: true, timeout: 60_000 })
      await expectClip(session, 'a paper boat for a client of the Video page')

      // The start loaded nothing beside the video model, and it is still the one resident.
      const status = await diffusionStatus(session.profile.dataFolder)
      expect(status.model.state).toBe('loaded')
      expect(status.model.loaded?.modality).toBe('video')
    })
  }, 300_000)
})
