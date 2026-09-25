/**
 * Remote access without Cloudflare. The core runs the tunnel program the app
 * hands it (`--cloudflared-bin`); an e2e build hands it only what the run put
 * next to its scripted sidecars (`<root>/sidecars/cloudflared`), so a scenario
 * installs the core's fake there. The core then proves the tunnel by fetching
 * its own OpenAPI document through Cloudflare's edge under the tunnel's name;
 * two environment hooks the core keeps for its own tests point that probe at a
 * TLS server here, which presents a certificate for the fake's tunnel name and
 * forwards to the profile's local API.
 */
import { chmod, mkdir, readFile } from 'node:fs/promises'
import { createServer, type Server } from 'node:https'
import { join } from 'node:path'
import { coreRequest } from './core.js'
import { CORE_REPO } from './fixtures.js'
import { listProcesses } from './platform.js'
import type { Profile } from './profile.js'
import type { Session } from './session.js'

/** The URL the fake mints; the edge's certificate is for this name. */
export const TUNNEL_URL = 'https://calm-river-demo.trycloudflare.com'
export const TUNNEL_HOST = 'calm-river-demo.trycloudflare.com'

export type FakeTunnelMode =
  | 'url-then-registered'
  | 'url-only'
  | 'registers-only-on-http2'
  | 'silent'
  | 'exit-immediately'
  | 'ready-then-exit'
  | 'ignore-sigterm'

const argvFileOf = (root: string) => join(root, 'fake-cloudflared.jsonl')

/** Stands the scripted `cloudflared` in for the bundled one, for this profile only. Call it from `prepare`. */
export async function installFakeCloudflared(
  profile: Profile,
  mode: FakeTunnelMode = 'url-then-registered'
): Promise<{ argvFile: string }> {
  const dir = join(profile.root, 'sidecars')
  await mkdir(dir, { recursive: true })
  const script = join(CORE_REPO, 'test', 'helpers', 'fake-cloudflared.mjs')
  const argvFile = argvFileOf(profile.root)
  const target = join(dir, 'cloudflared')
  const { writeFile } = await import('node:fs/promises')
  await writeFile(
    target,
    [
      '#!/bin/sh',
      `export FAKE_CLOUDFLARED_MODE=${mode} FAKE_CLOUDFLARED_ARGV_FILE=${JSON.stringify(argvFile)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`,
      '',
    ].join('\n')
  )
  await chmod(target, 0o755)
  return { argvFile }
}

export interface FakeEdge {
  /** `host:port`, for `ATOMIC_REMOTE_ACCESS_EDGE`. */
  address: string
  /** The certificate's file, for `ATOMIC_REMOTE_ACCESS_CA`. */
  caPath: string
  /** The `Host` of every request the edge relayed, in order. */
  hosts: () => Array<string | undefined>
  stop: () => Promise<void>
}

/**
 * Cloudflare's edge, as far as the core's probe can tell: a TLS server with the
 * tunnel name's certificate that hands each request to the origin the tunnel
 * points at — the profile's local API, whose port is known only once the
 * session exists, hence the lazy `originPort`.
 */
export async function startFakeEdge(originPort: () => number): Promise<FakeEdge> {
  const tls = join(CORE_REPO, 'test', 'fixtures', 'tls')
  const caPath = join(tls, 'tunnel.pem')
  const hosts: Array<string | undefined> = []
  const edge: Server = createServer(
    { key: await readFile(join(tls, 'tunnel.key')), cert: await readFile(caPath) },
    (req, res) => {
      hosts.push(req.headers.host)
      void fetch(`http://127.0.0.1:${originPort()}${req.url ?? '/'}`).then(
        async (origin) => {
          res.writeHead(origin.status, { 'content-type': origin.headers.get('content-type') ?? 'text/plain' })
          res.end(Buffer.from(await origin.arrayBuffer()))
        },
        () => void res.writeHead(502).end('no origin')
      )
    }
  )
  await new Promise<void>((resolve) => edge.listen(0, '127.0.0.1', resolve))
  const address = edge.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    address: `127.0.0.1:${port}`,
    caPath,
    hosts: () => [...hosts],
    stop: () => new Promise<void>((resolve) => edge.close(() => resolve())),
  }
}

/** Points the core the app starts at the fake edge. Call it from `prepare`, before the app launches. */
export function useFakeEdge(profile: Profile, edge: Pick<FakeEdge, 'address' | 'caPath'>): void {
  profile.env.ATOMIC_REMOTE_ACCESS_EDGE = edge.address
  profile.env.ATOMIC_REMOTE_ACCESS_CA = edge.caPath
}

export interface TunnelLaunch {
  argv: string[]
  /** The `TUNNEL_*` variables that reached the fake: the core scrubs the user's, so none. */
  tunnelEnv: string[]
  pid: number
}

/** Every start of the fake tunnel under this profile, in order. */
export async function tunnelLaunches(root: string): Promise<TunnelLaunch[]> {
  return (await readFile(argvFileOf(root), 'utf8').catch(() => ''))
    .split('\n')
    .filter(Boolean)
    .map((line) => JSON.parse(line) as TunnelLaunch)
}

/** Fake tunnels still alive under this profile, found by their own argv. */
export function liveFakeTunnels(root: string): number[] {
  return listProcesses()
    .filter((p) => p.command.includes('fake-cloudflared') && p.command.includes(root))
    .map((p) => p.pid)
}

/** Ends the fake tunnels this run started: they are in no backend journal, so nobody else will. */
export async function reapFakeTunnels(root: string): Promise<void> {
  for (const { pid } of await tunnelLaunches(root)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // gone, which is what the scenarios assert
    }
  }
}

export interface RemoteAccessStatus {
  state: string
  url: string | null
  error: string | null
  blockReason: string | null
  canStart: boolean
  canStop: boolean
  serverHasApiKey: boolean
}

export async function remoteAccessStatus(dataFolder: string): Promise<RemoteAccessStatus> {
  const res = await coreRequest(dataFolder, '/remote-access')
  if (!res.ok) throw new Error(`remote-access ${res.status}: ${await res.text()}`)
  return (await res.json()) as RemoteAccessStatus
}

export async function lanAddresses(dataFolder: string): Promise<string[]> {
  const res = await coreRequest(dataFolder, '/lan-addresses')
  return ((await res.json()) as { addresses: string[] }).addresses
}

/** Opens Settings → Remote & LAN the way a user does. */
export async function openRemoteLan(session: Session): Promise<void> {
  const browser = session.app.browser
  await browser.$('//*[normalize-space(text())="Settings"]').click()
  const entry = browser.$('//a[normalize-space(.)="Remote & LAN"]')
  await entry.waitForClickable({ timeout: 30_000 })
  await entry.click()
  await browser.$('section[aria-label="Remote access"]').waitForDisplayed({ timeout: 30_000 })
}

/** The state the Remote access card shows in its `<output>`. */
export async function remoteCardState(session: Session): Promise<string> {
  return (await session.app.browser.$('section[aria-label="Remote access"] output').getText()).trim()
}

/** The card's one action button (Start / Stop / Starting… / Stopping…). */
export function remoteCardAction(session: Session) {
  return session.app.browser.$('section[aria-label="Remote access"] button=Start, section[aria-label="Remote access"] button=Stop')
}
