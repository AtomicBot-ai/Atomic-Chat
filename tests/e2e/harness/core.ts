/**
 * Talks to the core daemon the app started, over the same control API the app
 * uses: the lock file names the port, the token file authorises the call.
 */
import { readFile } from 'node:fs/promises'
import { join } from 'node:path'
import { listProcesses } from './platform.js'

const CONTROL_PREFIX = '/atomic/v1'

export interface LockRecord {
  instance_id: string
  pid: number
  state: string
  control_host: string
  control_port: number
}

export async function readLock(dataFolder: string): Promise<LockRecord | null> {
  try {
    const raw = await readFile(join(dataFolder, 'atomic-core', 'instance.lock'), 'utf8')
    return JSON.parse(raw) as LockRecord
  } catch {
    return null
  }
}

async function readToken(dataFolder: string): Promise<string | null> {
  try {
    const token = (await readFile(join(dataFolder, 'atomic-core', 'control-token'), 'utf8')).trim()
    return token === '' ? null : token
  } catch {
    return null
  }
}

/** Resolves once the core reports ready, or null when no core ever came up. */
export async function waitForCore(
  dataFolder: string,
  timeoutMs = 30_000
): Promise<LockRecord | null> {
  const deadline = Date.now() + timeoutMs
  while (Date.now() < deadline) {
    const lock = await readLock(dataFolder)
    if (lock && lock.state === 'ready' && lock.control_port !== 0 && lock.control_host !== '') {
      return lock
    }
    await new Promise((r) => setTimeout(r, 200))
  }
  return null
}

export async function coreRequest(
  dataFolder: string,
  path: string,
  init: RequestInit = {}
): Promise<Response> {
  const lock = await readLock(dataFolder)
  const token = await readToken(dataFolder)
  if (!lock || !token) throw new Error(`no ready core under ${dataFolder}`)
  return fetch(`http://${lock.control_host}:${lock.control_port}${CONTROL_PREFIX}${path}`, {
    ...init,
    headers: { ...init.headers, authorization: `Bearer ${token}` },
  })
}

/** Core daemons serving this data folder, found by their own argv. */
function corePids(dataFolder: string): number[] {
  return listProcesses()
    .filter((p) => p.command.includes(' daemon ') && p.command.includes(`--data-folder ${dataFolder}`))
    .map((p) => p.pid)
}

/**
 * Stops the core this profile's app started. Call it AFTER the app is gone:
 * while the app lives, its supervisor treats a stopped core as a crash and
 * starts another. Once the app is dead no new core can appear, so one process
 * scan is authoritative — which matters because the app may be killed while
 * its core is still starting, before any lock file exists to find it by.
 */
export type CoreStop = 'no core' | 'exited after /shutdown' | 'killed after ignoring /shutdown'

export async function stopCore(dataFolder: string): Promise<CoreStop> {
  if (corePids(dataFolder).length === 0) return 'no core'
  if (await waitForCore(dataFolder, 25_000)) {
    // Forced, because the app was killed rather than quit: its registration
    // stays attached until it lapses some 45 s later, and an unforced shutdown
    // is refused while any client is attached. Without the force the core would
    // be killed below instead, orphaning the backends it never got to stop.
    await coreRequest(dataFolder, '/shutdown', {
      method: 'POST',
      headers: { 'content-type': 'application/json' },
      body: JSON.stringify({ force: true }),
    }).catch(() => undefined)
  }
  const deadline = Date.now() + 20_000
  while (Date.now() < deadline && corePids(dataFolder).length > 0) {
    await new Promise((r) => setTimeout(r, 200))
  }
  if (corePids(dataFolder).length === 0) return 'exited after /shutdown'
  for (const pid of corePids(dataFolder)) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // exited between the scan and the kill
    }
  }
  return 'killed after ignoring /shutdown'
}
