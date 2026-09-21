/**
 * Getting a model from the Hub: the landing page offers it, the user downloads
 * it and watches it arrive, and then talks to it. The catalog, the picks and the
 * model file come from a fixture on this machine whose address is baked into
 * the e2e build, so nothing here reaches a model host. Everything between the
 * click and the file on disk is the shipped path — the Hub, the extension's
 * import, the app's downloader, the GGUF check — and the chat afterwards runs
 * on the fixture backend like every other scenario.
 */
import { createHash } from 'node:crypto'
import { readdir, readFile, stat } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { coreSessions, pageShows, send, waitForChat } from '../harness/chat.js'
import { installFakeBackend, startHubFixture, type HubFixture } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND } from '../harness/platform.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_NAME = 'e2e/hub-fixture-GGUF'
const QUANT_ID = 'e2e/hub-fixture-Q4_K_M'
const TITLE = 'E2E Hub Fixture'
const REPLY = 'ATOMIC-E2E-HUB 1f8a'

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('downloading a model from the Hub', () => {
  let session: Session
  let hub: HubFixture

  beforeAll(async () => {
    hub = await startHubFixture({ modelName: MODEL_NAME, quantId: QUANT_ID, title: TITLE })
    session = await startSession('hub-download', {
      prepare: async (profile) => installFakeBackend(profile, { reply: REPLY }),
    })
  })

  afterAll(async () => {
    const left = await endSession(session)
    await hub.stop()
    expect(left).toEqual([])
  })

  it('offers the model, shows it arriving, keeps a valid file, and chats with it', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const dataFolder = session.profile.dataFolder

      // No model yet, so the app opens on onboarding; the Hub is the way in here.
      await browser.$('button=Skip').click()
      await waitForChat(session)
      await browser.$('//*[normalize-space(text())="Models"]').click()

      // The landing page shows the pick the fixture published.
      const card = browser.$(`//*[normalize-space(text())="${TITLE}"]`)
      await card.waitForDisplayed({ timeout: 60_000 })
      await card.click()

      const download = browser.$('//button[normalize-space(.)="Download"]')
      await download.waitForClickable({ timeout: 30_000 })

      // Progress is watched from before the click, in the Downloads panel: it is
      // over in seconds, and the app reports it once per 10 MB.
      const seen: { status: string; controls: string[] }[] = []
      let watching = true
      const watcher = (async () => {
        while (watching) {
          const now = await browser
            .execute(() => {
              const panel = document.querySelector('[role="region"][aria-label="Downloads"]')
              if (!panel) return null
              return {
                status: (panel as HTMLElement).innerText.replace(/\s+/g, ' ').trim(),
                controls: Array.from(panel.querySelectorAll('button')).map((b) => b.getAttribute('aria-label') ?? ''),
              }
            })
            .catch(() => null)
          if (now) seen.push(now)
          await new Promise((r) => setTimeout(r, 100))
        }
      })()
      await download.click()
      await pageShows(session, 'Download Complete', 120_000)
      watching = false
      await watcher

      // It was seen on its way — a share of the real total, not only the end —
      // and while it ran the user could pause or cancel it.
      const inFlight = seen.filter((s) => /\b([1-9]\d?)% · \d+ \/ 32 MB/.test(s.status))
      expect(inFlight.length, `the panel showed: ${JSON.stringify([...new Set(seen.map((s) => s.status))])}`).toBeGreaterThan(0)
      expect(inFlight[0]!.status).toContain(QUANT_ID.split('/')[1])
      expect(inFlight[0]!.controls).toEqual(expect.arrayContaining(['Pause download', 'Cancel download']))

      // The whole file arrived under the quant's id, and the importer accepted
      // it as a GGUF and described it for the app and the core.
      const modelDir = join(dataFolder, 'llamacpp', 'models', ...QUANT_ID.split('/'))
      expect((await stat(join(modelDir, 'model.gguf'))).size).toBe(hub.modelBytes)
      const yml = await readFile(join(modelDir, 'model.yml'), 'utf8')
      expect(yml).toContain(`model_path: llamacpp/models/${QUANT_ID}/model.gguf`)
      expect(yml).toContain(`size_bytes: ${hub.modelBytes}`)

      // The file was asked for from the fixture, without anybody's token.
      const fileRequests = hub.requests().filter((r) => r.path === '/model.gguf' && r.method === 'GET')
      expect(fileRequests.length).toBeGreaterThan(0)
      expect(fileRequests.every((r) => r.authorization === '')).toBe(true)

      // The Hub hands the fresh model straight to a new chat.
      await browser.$('//button[normalize-space(.)="New chat"]').click()
      await waitForChat(session)
      await send(session, 'hello, downloaded model')
      await pageShows(session, REPLY, 90_000)
      expect((await coreSessions(dataFolder)).map((s) => s.model_id)).toEqual([QUANT_ID])
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('cancelling a Hub download', () => {
  let session: Session
  let hub: HubFixture

  beforeAll(async () => {
    hub = await startHubFixture({ modelName: MODEL_NAME, quantId: QUANT_ID, title: TITLE })
    session = await startSession('hub-download-cancel')
  })

  afterAll(async () => {
    const left = await endSession(session)
    await hub.stop()
    expect(left).toEqual([])
  })

  it('stops the transfer, leaves no model behind, and lets the same model be downloaded again', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const modelDir = join(session.profile.dataFolder, 'llamacpp', 'models', ...QUANT_ID.split('/'))
      const panelStatus = () =>
        browser.execute(
          () => (document.querySelector('[role="region"][aria-label="Downloads"]') as HTMLElement | null)?.innerText ?? ''
        )

      await browser.$('button=Skip').click()
      await waitForChat(session)
      await browser.$('//*[normalize-space(text())="Models"]').click()
      const card = browser.$(`//*[normalize-space(text())="${TITLE}"]`)
      await card.waitForDisplayed({ timeout: 60_000 })
      await card.click()
      const download = browser.$('//button[normalize-space(.)="Download"]')
      await download.waitForClickable({ timeout: 30_000 })
      await download.click()

      // Part of it has arrived; then the user changes their mind.
      await expect.poll(panelStatus, { timeout: 60_000, interval: 100 }).toMatch(/\b[1-9]\d?% · /)
      await browser.$('[role="region"][aria-label="Downloads"] button[aria-label="Cancel download"]').click()

      // The panel goes away, the Hub offers the model again, and no model was
      // registered: nothing the app would list, nothing a load could pick up.
      await expect.poll(panelStatus, { timeout: 30_000 }).toBe('')
      await download.waitForDisplayed({ timeout: 30_000 })
      await expect(stat(join(modelDir, 'model.yml'))).rejects.toThrow()
      expect(await pageShows(session, 'Download Complete', 3_000).then(() => true, () => false)).toBe(false)

      // Cancelling left nothing in the way of doing it properly.
      await download.click()
      await pageShows(session, 'Download Complete', 120_000)
      expect((await stat(join(modelDir, 'model.gguf'))).size).toBe(hub.modelBytes)
      // The model's description is written a moment after the toast.
      await expect
        .poll(() => readFile(join(modelDir, 'model.yml'), 'utf8').catch(() => ''))
        .toContain(`size_bytes: ${hub.modelBytes}`)
    })
  })
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('pausing a Hub download', () => {
  let session: Session
  let hub: HubFixture

  beforeAll(async () => {
    hub = await startHubFixture({ modelName: MODEL_NAME, quantId: QUANT_ID, title: TITLE })
    session = await startSession('hub-download-pause')
  })

  afterAll(async () => {
    const left = await endSession(session)
    await hub.stop()
    expect(left).toEqual([])
  })

  it('holds the transfer where it is, and picks it up from there instead of starting over', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const modelDir = join(session.profile.dataFolder, 'llamacpp', 'models', ...QUANT_ID.split('/'))
      const panel = '[role="region"][aria-label="Downloads"]'
      const panelStatus = () =>
        browser.execute(
          () => (document.querySelector('[role="region"][aria-label="Downloads"]') as HTMLElement | null)?.innerText ?? ''
        )
      /** Bytes of the model that are on disk, whatever the partial file is called. */
      const bytesOnDisk = async () => {
        const names = await readdir(modelDir).catch(() => [] as string[])
        const sizes = await Promise.all(names.map((name) => stat(join(modelDir, name)).then((s) => s.size, () => 0)))
        return sizes.reduce((sum, size) => sum + size, 0)
      }

      await browser.$('button=Skip').click()
      await waitForChat(session)
      await browser.$('//*[normalize-space(text())="Models"]').click()
      const card = browser.$(`//*[normalize-space(text())="${TITLE}"]`)
      await card.waitForDisplayed({ timeout: 60_000 })
      await card.click()
      const download = browser.$('//button[normalize-space(.)="Download"]')
      await download.waitForClickable({ timeout: 30_000 })
      await download.click()

      await expect.poll(panelStatus, { timeout: 60_000, interval: 100 }).toMatch(/\b[1-9]\d?% · /)
      await browser.$(`${panel} button[aria-label="Pause download"]`).click()

      // The panel says so and offers to go on; what has arrived stays, and no
      // more arrives while the user is away.
      await browser.$(`${panel} button[aria-label="Resume download"]`).waitForDisplayed({ timeout: 30_000 })
      expect(await panelStatus()).toContain('Paused')
      const held = await bytesOnDisk()
      expect(held).toBeGreaterThan(0)
      expect(held).toBeLessThan(hub.modelBytes)
      await new Promise((r) => setTimeout(r, 2_000))
      expect(await bytesOnDisk()).toBe(held)
      await expect(stat(join(modelDir, 'model.yml'))).rejects.toThrow()

      await browser.$(`${panel} button[aria-label="Resume download"]`).click()
      await pageShows(session, 'Download Complete', 120_000)

      // It went on from the bytes it had — the server was asked for the rest,
      // not for the file again — and the pieces make the file the fixture serves.
      const ranged = hub
        .requests()
        .filter((r) => r.path === '/model.gguf' && r.method === 'GET')
        .map((r) => Number(/^bytes=(\d+)-/.exec(r.range)?.[1] ?? 0))
      expect(ranged.some((from) => from > 0), `GET /model.gguf started at: ${JSON.stringify(ranged)}`).toBe(true)
      const file = await readFile(join(modelDir, 'model.gguf'))
      expect(file.length).toBe(hub.modelBytes)
      expect(createHash('sha256').update(file).digest('hex')).toBe(hub.modelSha256)
      expect(await readFile(join(modelDir, 'model.yml'), 'utf8')).toContain(`size_bytes: ${hub.modelBytes}`)
    })
  })
})
