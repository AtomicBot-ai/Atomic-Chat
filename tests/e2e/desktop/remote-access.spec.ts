/**
 * Settings → Remote & LAN on the core. Remote access starts a Cloudflare quick
 * tunnel in front of the Local API Server, shows the public URL with a QR
 * code, serves the API through it, and stops it; without an API key it asks
 * first. When the tunnel cannot register, or the program is missing, the card
 * says why. LAN access lists this computer's addresses and serves them.
 *
 * The tunnel program is the core's scripted `cloudflared`, installed as this
 * profile's sidecar; Cloudflare's edge is a TLS server here that the core's
 * probe is pointed at (harness/remote-access.ts). Nothing leaves the machine.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { afterAll, beforeAll, describe, expect, it } from 'vitest'
import { isAlive } from '../harness/chat.js'
import { writeFakeModel } from '../harness/fixtures.js'
import { CAN_RUN_FAKE_BACKEND, listProcesses } from '../harness/platform.js'
import type { Profile } from '../harness/profile.js'
import {
  installFakeCloudflared,
  lanAddresses,
  liveFakeTunnels,
  openRemoteLan,
  remoteAccessStatus,
  remoteCardState,
  startFakeEdge,
  TUNNEL_HOST,
  TUNNEL_URL,
  tunnelLaunches,
  useFakeEdge,
  type FakeEdge,
} from '../harness/remote-access.js'
import { endSession, startSession, withArtifacts, type Session } from '../harness/session.js'

const MODEL_ID = 'e2e/fake-model'
const LOCAL_API_KEY = 'e2e-remote-key'
const REMOTE = 'section[aria-label="Remote access"]'
const LAN = 'section[aria-label="LAN access"]'

/** The port the profile's local API will listen on: written into the webview seed before `prepare` runs. */
async function apiPortOf(profile: Profile): Promise<number> {
  const seed = JSON.parse(await readFile(join(profile.root, 'webview-seed.json'), 'utf8')) as Record<string, string>
  return (JSON.parse(seed['setting-local-api-server'] as string) as { state: { serverPort: number } }).state.serverPort
}

const models = (port: number, key?: string) =>
  fetch(`http://127.0.0.1:${port}/v1/models`, { headers: key ? { authorization: `Bearer ${key}` } : {} })

/** The command line of the core this profile's app started. */
function coreCommand(dataFolder: string): string {
  return listProcesses().find((p) => p.command.includes(' daemon ') && p.command.includes(`--data-folder ${dataFolder}`))?.command ?? ''
}

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('remote access with an API key', () => {
  let session: Session
  let edge: FakeEdge

  beforeAll(async () => {
    let port = 0
    edge = await startFakeEdge(() => port)
    session = await startSession('remote-access', {
      apiServer: { apiKey: LOCAL_API_KEY },
      prepare: async (profile) => {
        port = await apiPortOf(profile)
        await writeFakeModel(profile, MODEL_ID)
        await installFakeCloudflared(profile, 'url-then-registered')
        useFakeEdge(profile, edge)
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await edge?.stop()
    expect(left).toEqual([])
  })

  it('starts remote access from Settings, shows the public URL with a QR code, serves the API through it, and stops the tunnel', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const { dataFolder, root } = session.profile

      await openRemoteLan(session)
      expect(await remoteCardState(session)).toBe('Off')
      await browser.$(`${REMOTE} button=Start`).click()
      await browser.waitUntil(async () => (await remoteCardState(session)) === 'Online', {
        timeout: 60_000,
        timeoutMsg: `remote access never came online: ${JSON.stringify(await remoteAccessStatus(dataFolder))}`,
      })

      // The local API came up by itself, and the tunnel points at it.
      expect((await models(session.apiPort, LOCAL_API_KEY)).status).toBe(200)
      expect(await remoteAccessStatus(dataFolder)).toMatchObject({ state: 'online', url: TUNNEL_URL, error: null, serverHasApiKey: true })
      const [launch] = await tunnelLaunches(root)
      expect(launch?.argv).toEqual(['tunnel', '--config', '/dev/null', '--url', `http://127.0.0.1:${session.apiPort}`, '--no-autoupdate'])
      expect(launch?.tunnelEnv).toEqual([])
      expect(isAlive(launch?.pid as number)).toBe(true)
      // The app handed the core the profile's own tunnel program, never the bundled one.
      expect(coreCommand(dataFolder)).toContain(`--cloudflared-bin ${join(root, 'sidecars', 'cloudflared')}`)
      // The core proved the tunnel through "Cloudflare's edge" under the tunnel's name.
      expect(edge.hosts()).toContain(TUNNEL_HOST)

      // The page: the URL, its QR code.
      const urlRow = browser.$(`${REMOTE} [role="group"][aria-label="${TUNNEL_URL}"]`)
      await urlRow.waitForDisplayed({ timeout: 15_000 })
      await urlRow.$('button[aria-label="Show QR code"]').click()
      await browser.$('[data-testid="access-qr-code"]').waitForDisplayed({ timeout: 15_000 })
      await browser.keys('Escape')
      await browser.waitUntil(async () => !(await browser.$('[data-testid="access-qr-code"]').isExisting()), { timeout: 15_000 })

      await browser.$(`${REMOTE} button=Stop`).click()
      await browser.waitUntil(async () => (await remoteCardState(session)) === 'Off', { timeout: 30_000 })
      expect(await remoteAccessStatus(dataFolder)).toMatchObject({ state: 'off', url: null, canStart: true })
      await browser.waitUntil(async () => !isAlive(launch?.pid as number), { timeout: 15_000 })
      expect(liveFakeTunnels(root)).toEqual([])
      // The local API is untouched by the tunnel going.
      expect((await models(session.apiPort, LOCAL_API_KEY)).status).toBe(200)
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('remote access without an API key', () => {
  let session: Session
  let edge: FakeEdge

  beforeAll(async () => {
    let port = 0
    edge = await startFakeEdge(() => port)
    session = await startSession('remote-access-no-key', {
      prepare: async (profile) => {
        port = await apiPortOf(profile)
        await writeFakeModel(profile, MODEL_ID)
        await installFakeCloudflared(profile, 'url-then-registered')
        useFakeEdge(profile, edge)
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await edge?.stop()
    expect(left).toEqual([])
  })

  it('asks before exposing an API without a key, and generates one when told to', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const { dataFolder, root } = session.profile
      await openRemoteLan(session)

      await browser.$(`${REMOTE} button=Start`).click()
      const dialog = browser.$('[role="dialog"]')
      await dialog.waitForDisplayed({ timeout: 15_000 })
      expect(await dialog.getText()).toContain('Start without an API key?')
      await dialog.$('button=Cancel').click()
      await browser.waitUntil(async () => !(await dialog.isExisting()) || !(await dialog.isDisplayed()), { timeout: 15_000 })
      expect(await tunnelLaunches(root)).toEqual([])
      expect((await remoteAccessStatus(dataFolder)).state).toBe('off')

      await browser.$(`${REMOTE} button=Start`).click()
      await dialog.waitForDisplayed({ timeout: 15_000 })
      await dialog.$('button=Generate key and start').click()
      await browser.waitUntil(async () => (await remoteCardState(session)) === 'Online', { timeout: 60_000 })
      // A key now guards the listener; the page kept it for the user.
      const key = await browser.execute(() => {
        const stored = JSON.parse(localStorage.getItem('setting-local-api-server') ?? '{}') as { state?: { apiKey?: string } }
        return stored.state?.apiKey ?? ''
      })
      expect(key).not.toBe('')
      expect((await models(session.apiPort)).status).toBe(401)
      expect((await models(session.apiPort, key)).status).toBe(200)
      expect((await remoteAccessStatus(dataFolder)).serverHasApiKey).toBe(true)

      await browser.$(`${REMOTE} button=Stop`).click()
      await browser.waitUntil(async () => (await remoteCardState(session)) === 'Off', { timeout: 30_000 })
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('remote access that cannot start', () => {
  let session: Session
  let edge: FakeEdge

  beforeAll(async () => {
    let port = 0
    edge = await startFakeEdge(() => port)
    session = await startSession('remote-access-failures', {
      apiServer: { apiKey: LOCAL_API_KEY },
      prepare: async (profile) => {
        port = await apiPortOf(profile)
        await writeFakeModel(profile, MODEL_ID)
        // Mints a URL but never registers, over either transport.
        await installFakeCloudflared(profile, 'url-only')
        useFakeEdge(profile, edge)
      },
    })
  })

  afterAll(async () => {
    const left = session ? await endSession(session) : []
    await edge?.stop()
    expect(left).toEqual([])
  })

  it('says why remote access could not start when the tunnel never registers', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const { dataFolder, root } = session.profile
      await openRemoteLan(session)
      await browser.$(`${REMOTE} button=Start`).click()
      // The first attempt gets its 15 s to register, then the HTTP/2 retry gets the same.
      await browser.waitUntil(async () => (await remoteCardState(session)) === 'Error', {
        timeout: 90_000,
        timeoutMsg: `still ${await remoteCardState(session)}: ${JSON.stringify(await remoteAccessStatus(dataFolder))}`,
      })
      expect(await remoteAccessStatus(dataFolder)).toMatchObject({ state: 'error', error: 'not_registered', url: null, canStart: true })
      expect(await browser.$(`${REMOTE} [role="alert"]`).getText()).toContain('could not connect to Cloudflare')
      const launches = await tunnelLaunches(root)
      expect(launches).toHaveLength(2)
      expect(launches[1]?.argv.slice(-2)).toEqual(['--protocol', 'http2'])
      for (const { pid } of launches) expect(isAlive(pid)).toBe(false)
      expect(await browser.$(`${REMOTE} button=Start`).isEnabled()).toBe(true)
    })
  }, 300_000)
})

describe.skipIf(!CAN_RUN_FAKE_BACKEND)('remote access in a build without the tunnel program', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('remote-access-missing', {
      apiServer: { apiKey: LOCAL_API_KEY },
      prepare: async (profile) => {
        await writeFakeModel(profile, MODEL_ID)
        // A sidecars folder with no cloudflared in it: the app hands the core nothing.
        const { mkdir } = await import('node:fs/promises')
        await mkdir(join(profile.root, 'sidecars'), { recursive: true })
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it('says the tunnel program is missing', async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const { dataFolder, root } = session.profile
      expect(coreCommand(dataFolder)).not.toContain('--cloudflared-bin')
      await openRemoteLan(session)
      await browser.$(`${REMOTE} button=Start`).click()
      await browser.waitUntil(async () => (await remoteCardState(session)) === 'Error', { timeout: 30_000 })
      expect(await remoteAccessStatus(dataFolder)).toMatchObject({ state: 'error', error: 'cloudflared_unavailable', canStart: true })
      expect(await browser.$(`${REMOTE} [role="alert"]`).getText()).toContain('cloudflared')
      expect(await tunnelLaunches(root)).toEqual([])
    })
  }, 120_000)
})

// Binding the local API on every interface exposes it on the operator's own
// network for the length of the scenario, and may raise the macOS firewall
// prompt: opt in.
describe.skipIf(!CAN_RUN_FAKE_BACKEND || process.env.E2E_LAN !== '1')('LAN access', () => {
  let session: Session

  beforeAll(async () => {
    session = await startSession('lan-access', {
      apiServer: { apiKey: LOCAL_API_KEY },
      prepare: async (profile) => {
        await writeFakeModel(profile, MODEL_ID)
      },
    })
  })

  afterAll(async () => {
    expect(await endSession(session)).toEqual([])
  })

  it("lists this computer's network addresses for LAN access and serves them only while it is on", async () => {
    await withArtifacts(session, async () => {
      const browser = session.app.browser
      const { dataFolder } = session.profile
      await openRemoteLan(session)
      await browser.$(`${LAN} button=Start`).click()
      await browser.waitUntil(async () => (await browser.$(`${LAN} output`).getText()).trim() === 'Online', { timeout: 60_000 })

      const addresses = await lanAddresses(dataFolder)
      const shown = await browser.$$(`${LAN} [role="group"]`)
      const urls: string[] = []
      for (const row of shown) urls.push((await row.getAttribute('aria-label')) ?? '')
      expect(urls.sort()).toEqual(addresses.map((address) => `http://${address}:${session.apiPort}/v1`).sort())
      if (addresses.length === 0) {
        expect(await browser.$(LAN).getText()).toContain('no network address')
        return
      }
      // Proven on the first listed address that actually reaches this listener: a VPN's shared-space
      // address is listed on purpose but may belong to a proxy.
      let reached: string | undefined
      for (const address of addresses) {
        const res = await fetch(`http://${address}:${session.apiPort}/v1/models`, { headers: { authorization: `Bearer ${LOCAL_API_KEY}` } }).catch(() => null)
        if (res?.status === 200) {
          reached = address
          break
        }
      }
      expect(reached).toBeDefined()

      await browser.$(`${LAN} button=Stop`).click()
      await browser.waitUntil(async () => (await browser.$(`${LAN} output`).getText()).trim() === 'Off', { timeout: 30_000 })
      // Off the network, still on loopback.
      await expect(
        fetch(`http://${reached}:${session.apiPort}/v1/models`, { headers: { authorization: `Bearer ${LOCAL_API_KEY}` } })
      ).rejects.toThrow()
      expect((await models(session.apiPort, LOCAL_API_KEY)).status).toBe(200)
    })
  }, 300_000)
})
