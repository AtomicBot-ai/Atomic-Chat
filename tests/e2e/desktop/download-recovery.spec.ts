/** Real WebKit/native downloader QA. Only scenario-owned files and loopback traffic. */
import { createHash } from 'node:crypto'
import { mkdir, readFile, readdir, stat, writeFile } from 'node:fs/promises'
import { createServer as httpServer, request } from 'node:http'
import { createServer as httpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { CORE_REPO, startHubFixture, type HubFixture } from '../harness/fixtures.js'
import { proxySeed } from '../harness/backend-mirror.js'
import { endSession, restartApp, startSession, withArtifacts, type Session } from '../harness/session.js'
import { openSection, openSidebarRow } from '../harness/navigation.js'
import { waitForChat, pageShows } from '../harness/chat.js'
import { ARTIFACTS_ROOT } from '../harness/artifacts.js'

const MODEL = 'e2e/recovery-fixture-GGUF'
const ID = 'e2e/recovery-fixture-Q4_K_M'
const TITLE = 'E2E Recovery Fixture'
const SOURCE = 'https://huggingface.co/e2e/recovery-fixture/resolve/main/model-Q4_K_M.gguf'
const PANEL = '[role="region"][aria-label="Downloads"]'
const sha = (value: Buffer) => createHash('sha256').update(value).digest('hex')

/** Preserve a public source identity without ever contacting a model host.
 * The profile's existing proxy/TLS settings apply only to this isolated app.
 */
async function mirrorDownload() {
  const sockets = new Set<Socket>()
  const origin = httpsServer({
    key: await readFile(join(CORE_REPO, 'test/fixtures/tls/server.key')),
    cert: await readFile(join(CORE_REPO, 'test/fixtures/tls/server.pem')),
  }, (req, res) => {
    if (req.url !== new URL(SOURCE).pathname) return void res.writeHead(404).end()
    const upstream = request('http://127.0.0.1:47391/model.gguf', {
      method: req.method, headers: req.headers,
    }, (reply) => {
      res.writeHead(reply.statusCode ?? 500, reply.headers)
      reply.pipe(res)
    })
    upstream.on('error', () => res.destroy())
    res.on('close', () => upstream.destroy())
    upstream.end()
  })
  const proxy = httpServer((_req, res) => void res.writeHead(502).end())
  const listen = (server: typeof proxy | typeof origin) => new Promise<number>((resolve) => {
    server.listen(0, '127.0.0.1', () => {
      const address = server.address()
      resolve(typeof address === 'object' && address ? address.port : 0)
    })
  })
  const port = await listen(origin)
  proxy.on('connect', (_req, socket: Socket, head: Buffer) => {
    const upstream = connect(port, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream); upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
    socket.on('close', () => upstream.destroy())
  })
  for (const server of [origin, proxy]) server.on('connection', (socket: Socket) => {
    sockets.add(socket); socket.once('close', () => sockets.delete(socket))
  })
  const proxyPort = await listen(proxy)
  return {
    url: `http://127.0.0.1:${proxyPort}`,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([origin, proxy].map((s) => new Promise<void>((r) => s.close(() => r()))))
    },
  }
}

describe('real app download recovery and guarded deletion', () => {
  let session: Session
  let hub: HubFixture
  let mirror: Awaited<ReturnType<typeof mirrorDownload>>
  const evidence = join(ARTIFACTS_ROOT, 'download-recovery-success')
  const modelDir = () => join(session.profile.dataFolder, 'llamacpp/models', ID)
  const status = () => session.app.browser.execute((selector) =>
    (document.querySelector(selector) as HTMLElement | null)?.innerText ?? '', PANEL)
  const rows = () => session.app.browser.$$(`${PANEL} li`).length
  const payload = async () => {
    const names = await readdir(modelDir())
    const name = names.find((n) => n.endsWith('.gguf.tmp')) ?? names.find((n) => n.endsWith('.gguf'))
    if (!name) throw new Error(`No payload in ${names.join(', ')}`)
    return readFile(join(modelDir(), name))
  }
  const screenshot = async (name: string) => {
    // Capture the settled dialog instead of the first frame of its fade-in.
    await new Promise((resolve) => setTimeout(resolve, 350))
    return session.app.browser.saveScreenshot(join(evidence, `${name}.png`))
  }
  async function openHub() {
    const browser = session.app.browser
    await openSection(browser, 'models')
    const row = browser.$(`//button[@aria-expanded="false"][.//*[normalize-space(text())="${TITLE}"]]`)
    await browser.$(`//*[normalize-space(text())="${TITLE}"]`).waitForDisplayed({ timeout: 60_000 })
    if (await row.isExisting()) await row.click()
  }
  async function startPartial(probeVisibility = false) {
    await openHub()
    const button = session.app.browser.$('//button[normalize-space(.)="Download"]')
    await button.waitForClickable({ timeout: 30_000 })
    await button.click()
    await expect.poll(status, { timeout: 60_000 }).toMatch(/\b[1-9]\d?% · /)
    if (probeVisibility) {
      // Reproduce an early/late terminal notification while native I/O still
      // runs. Wait for React to paint, not for another progress update to hide
      // a lost-row bug. The actual importer must remain the owner of the row.
      const count = await session.app.browser.executeAsync((id: string, done: (count: number) => void) => {
        const core = (window as unknown as { core: { events: { emit: (name: string, data: unknown) => void } } }).core
        core.events.emit('onFileDownloadAndVerificationSuccess', { modelId: id, downloadType: 'Model' })
        requestAnimationFrame(() => requestAnimationFrame(() => done(document.querySelectorAll('[role="region"][aria-label="Downloads"] li').length)))
      }, ID)
      expect(count).toBe(1)
      expect(await session.app.browser.$('body').getText()).not.toContain('Download Complete')
      await screenshot('00-active-after-early-terminal-event')
    }
    await session.app.browser.$(`${PANEL} button[aria-label="Pause download"]`).click()
    await session.app.browser.$(`${PANEL} button[aria-label="Resume download"]`).waitForDisplayed({ timeout: 30_000 })
    // Abort completion can trail the UI's paused state by one final disk write.
    await new Promise((resolve) => setTimeout(resolve, 1000))
  }

  beforeAll(async () => {
    await mkdir(evidence, { recursive: true })
    hub = await startHubFixture({ modelName: MODEL, quantId: ID, title: TITLE,
      modelBytes: 64 * 1024 * 1024, chunkDelayMs: 300, modelUrl: SOURCE, sizeLabel: '0.06 GB' })
    mirror = await mirrorDownload()
    session = await startSession('download-recovery', { webviewSeed: proxySeed(mirror.url) })
    await session.app.browser.$('button=Skip').click()
    await waitForChat(session)
  })
  afterAll(async () => {
    const left = await endSession(session)
    await mirror?.stop()
    await hub?.stop()
    expect(left).toEqual([])
  })

  it('restores one paused row after a full restart and reopens the same Hub request without another transfer', async () => {
    await withArtifacts(session, async () => {
      await startPartial(true)
      const before = await payload()
      // Segmented transfers preallocate the final size. The manifest, not stat(),
      // tells how many bytes actually arrived; hash the whole sparse payload too.
      const manifest = JSON.parse(await readFile(join(modelDir(), 'model.gguf.parts'), 'utf8')) as { segments: number[][] }
      const transferred = manifest.segments.reduce((sum, [start, written]) => sum + written! - start!, 0)
      expect(transferred).toBeGreaterThan(0)
      expect(transferred).toBeLessThan(hub.modelBytes)
      await screenshot('01-paused')
      await restartApp(session)
      await expect.poll(status, { timeout: 60_000 }).toContain('Paused')
      expect(await rows()).toBe(1)
      expect(sha(await payload())).toBe(sha(before))
      const getCount = () => hub.requests().filter((r) => r.path === '/model.gguf' && r.method === 'GET').length
      const requests = getCount()
      await openHub()
      const show = session.app.browser.$('button[aria-label="Show download progress"]')
      await show.waitForClickable({ timeout: 30_000 })
      for (let at = 0; at < 3; at++) await show.click()
      expect(await rows()).toBe(1)
      expect(getCount()).toBe(requests)
      expect(sha(await payload())).toBe(sha(before))
      await screenshot('02-restored-single-row')
      await writeFile(join(evidence, 'restoration.json'), JSON.stringify({ pausedBytes: transferred,
        pausedSha256: sha(before), rowsAfterRestart: 1, extraGetsAfterRepeatedSelection: 0 }, null, 2))
      await openSection(session.app.browser, 'models')
      await openSidebarRow(session.app.browser, 'Downloads')
      await session.app.browser.$('[data-testid="downloads-row"] button[aria-label="Resume download"]').click()
      await session.app.browser.$('[data-testid="downloads-row"] button[aria-label="Pause download"]').waitForClickable()
      await session.app.browser.$('[data-testid="downloads-row"] button[aria-label="Pause download"]').click()
      await session.app.browser.$('[data-testid="downloads-row"] button[aria-label="Resume download"]').waitForDisplayed()
      await new Promise((resolve) => setTimeout(resolve, 1000))
      expect(await rows()).toBe(1)
      await screenshot('02b-downloads-page-paused')
    })
  })

  it('keeps files on cancellation and resumes the retained source to an exact final hash', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const before = await payload()
      await browser.$(`${PANEL} button[aria-label="Cancel download"]`).click()
      await browser.$('button=Cancel download and keep files').waitForDisplayed()
      await screenshot('03-cancel-confirmation')
      await browser.$('button=Cancel download and keep files').click()
      await expect.poll(status).toBe('')
      expect(sha(await payload())).toBe(sha(before))
      await restartApp(session)
      await waitForChat(session)
      expect(await status()).toBe('')
      await openHub()
      // A restart owns a fresh WebDriver session; use it for subsequent UI calls.
      const current = session.app.browser
      await current.$('//button[normalize-space(.)="Download"]').click()
      await pageShows(session, 'Download Complete', 120_000)
      const final = await readFile(join(modelDir(), 'model.gguf'))
      expect(final.length).toBe(hub.modelBytes)
      expect(sha(final)).toBe(hub.modelSha256)
      expect(hub.requests().some((r) => r.method === 'GET' && /^bytes=[1-9]/.test(r.range))).toBe(true)
      await expect.poll(() => readFile(join(modelDir(), 'model.yml'), 'utf8').catch(() => '')).toContain('model_path:')
      await screenshot('04-complete-after-resume')
      await writeFile(join(evidence, 'completion.json'), JSON.stringify({ size: final.length, sha256: sha(final),
        expectedSha256: hub.modelSha256, requests: hub.requests() }, null, 2))
    })
  }, 180_000)

  it('permanently deletes only the selected unfinished fixture through the new Downloads page', async () => {
    // A fresh isolated profile keeps the completed fixture above as independent evidence.
    expect(await endSession(session)).toEqual([])
    session = await startSession('download-recovery-delete', { webviewSeed: proxySeed(mirror.url) })
    await withArtifacts(session, async () => {
      await session.app.browser.$('button=Skip').click()
      await waitForChat(session)
      const neighbour = join(session.profile.dataFolder, 'llamacpp/models/e2e/untouched')
      await mkdir(neighbour, { recursive: true })
      await writeFile(join(neighbour, 'keep.gguf'), 'neighbour must remain byte-identical')
      const before = sha(await readFile(join(neighbour, 'keep.gguf')))
      await startPartial()
      await openSection(session.app.browser, 'models')
      await openSidebarRow(session.app.browser, 'Downloads')
      // Only the requested in-progress row has a cancellation control.
      await session.app.browser.$('[data-testid="downloads-row"] button[aria-label="Cancel download"]').click()
      await session.app.browser.$('button=Cancel download and permanently delete files').waitForDisplayed()
      await screenshot('05-delete-confirmation')
      await session.app.browser.$('button=Cancel download and permanently delete files').click()
      await expect.poll(() => stat(modelDir()).then(() => true, () => false)).toBe(false)
      await expect.poll(status).toBe('')
      expect(sha(await readFile(join(neighbour, 'keep.gguf')))).toBe(before)
      await restartApp(session)
      await waitForChat(session)
      expect(await status()).toBe('')
      expect(sha(await readFile(join(neighbour, 'keep.gguf')))).toBe(before)
      await screenshot('06-deleted-after-restart')
      await writeFile(join(evidence, 'deletion.json'), JSON.stringify({ selectedRemoved: true,
        absentAfterRestart: true, neighbourSha256Before: before,
        neighbourSha256After: sha(await readFile(join(neighbour, 'keep.gguf'))) }, null, 2))
    })
  }, 180_000)
})
