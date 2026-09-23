/**
 * One scenario's lifecycle: an isolated profile, the app running on it, a
 * restart that keeps the profile, and an end that proves nothing leaked.
 */
import { freePort, launchApp, type RunningApp } from './app.js'
import { captureFailure } from './artifacts.js'
import { stopCore } from './core.js'
import {
  FAKE_BACKEND,
  FAKE_BACKEND_VERSION,
  FAKE_PROVIDER,
  installFakeBackend,
  installedBackends,
  reapFakeBackends,
} from './fixtures.js'
import { readFileSync } from 'node:fs'
import { join } from 'node:path'
import { installedImageEngines } from './images.js'
import { CAN_RUN_FAKE_BACKEND, listProcesses } from './platform.js'
import { operatorStateChanges, snapshotOperatorState, type OperatorSnapshot } from './invariants.js'
import { createProfile, type Profile } from './profile.js'
import { reapFakeTunnels } from './remote-access.js'

const REPO_ROOT = join(import.meta.dirname, '..', '..', '..')

export interface Session {
  name: string
  profile: Profile
  apiPort: number
  app: RunningApp
  operatorBefore: OperatorSnapshot
  /** Every data folder the app has used in this run; a relocation adds one. */
  dataFolders: string[]
  /** Stops every page watcher still running; safe to call twice. */
  watchers: (() => Promise<unknown>)[]
  /** The backends (`provider:version/backend`) this run may leave installed. */
  allowedBackends: string[]
  /** The image engines (`tag/backendId`) this run may leave installed. */
  allowedImageEngines: string[]
}

/**
 * The backend pair the app bundles and unpacks into a fresh data folder on its
 * first launch (`install_bundled_backend` in each llama.cpp plugin): the tags
 * of `src-tauri/resources/llamacpp-backend{,-upstream}/{version,backend}.txt`
 * when a dev build fetched them. Their arrival is the app's own doing, not a
 * download the scenario missed, so the teardown expects them.
 */
export function bundledBackends(): string[] {
  const root = join(REPO_ROOT, 'src-tauri', 'resources')
  const found: string[] = []
  for (const [provider, dir] of [
    ['llamacpp-upstream', 'llamacpp-backend-upstream'],
    ['llamacpp', 'llamacpp-backend'],
  ] as const) {
    try {
      const version = readFileSync(join(root, dir, 'version.txt'), 'utf8').replace(/\uFEFF/g, '').trim()
      const backend = readFileSync(join(root, dir, 'backend.txt'), 'utf8').replace(/\uFEFF/g, '').trim()
      if (version && backend) found.push(`${provider}:${version}/${backend}`)
    } catch {
      // not fetched on this machine: nothing gets unpacked
    }
  }
  return found
}

export async function startSession(
  name: string,
  options: {
    webviewSeed?: Record<string, string>
    apiServer?: Record<string, unknown>
    prepare?: (profile: Profile) => Promise<void>
    /** Release tag of the scripted backend every profile gets; the newest-possible one by default. */
    backendVersion?: string
    /** Backends the scenario is expected to install on top of that one. */
    alsoAllowedBackends?: string[]
    /** Image engines (`tag/backendId`) the scenario installs or brings; anything else is a leak. */
    imageEngines?: string[]
  } = {}
): Promise<Session> {
  const operatorBefore = await snapshotOperatorState()
  const apiPort = await freePort()
  const profile = await createProfile({
    apiPort,
    apiServer: options.apiServer,
    webviewSeed: options.webviewSeed,
  })
  try {
    // Every profile gets a backend, whether or not the scenario loads a model:
    // on a profile without one the upstream extension downloads and installs
    // the real thing on first launch, without asking. A scenario's own
    // `prepare` may install it again with other options; the last one wins.
    const backendVersion = options.backendVersion ?? FAKE_BACKEND_VERSION
    if (CAN_RUN_FAKE_BACKEND) await installFakeBackend(profile, { version: backendVersion })
    await options.prepare?.(profile)
    const app = await launchApp(profile.env)
    return {
      name,
      profile,
      apiPort,
      app,
      operatorBefore,
      dataFolders: [profile.dataFolder],
      watchers: [],
      allowedBackends: [
        `${FAKE_PROVIDER}:${backendVersion}/${FAKE_BACKEND}`,
        ...bundledBackends(),
        ...(options.alsoAllowedBackends ?? []),
      ],
      allowedImageEngines: options.imageEngines ?? [],
    }
  } catch (error) {
    await stopCore(profile.dataFolder)
    await profile.destroy()
    throw error
  }
}

/**
 * A full quit and a new launch on the same profile. The core is stopped too:
 * a user's quit ends it, while the kill a test has to use (closing the window
 * only hides the app on macOS) would leave it running for the next launch.
 */
export async function restartApp(session: Session): Promise<void> {
  await session.app.stop()
  await stopCore(session.profile.dataFolder)
  session.app = await launchApp(session.profile.env)
}

/** Runs a scenario body and, when it fails, keeps what is needed to read the failure. */
export async function withArtifacts(session: Session, body: () => Promise<void>): Promise<void> {
  try {
    await body()
  } catch (error) {
    const dir = await captureFailure(session.name, session.app, session.profile.dataFolder)
    throw new Error(`${String(error)}\nartifacts: ${dir}`, { cause: error })
  }
}

/** Processes started from inside the profile: backends the core spawned out of its data folder. */
function profileProcesses(root: string): { pid: number; command: string }[] {
  return listProcesses().filter((p) => p.command.includes(root) && !p.command.includes(' daemon '))
}

/**
 * Tears the run down and reports what it left behind: changes outside its own
 * root, and processes that outlived the app and the core. Both are failures of
 * the same kind — the run reached past its own end. The app goes first: while
 * it lives, its supervisor restarts a stopped core.
 *
 * A session that never started — `startSession` threw in `beforeAll` and has
 * already cleaned up after itself — leaves nothing to report. Throwing here
 * instead would skip the rest of the `afterAll`, and a fixture it stops, such as
 * the Hub server on its fixed port, would fail every scenario after it.
 */
export async function endSession(session: Session | undefined): Promise<string[]> {
  if (session === undefined) return []
  // Before the app goes: a watcher left polling a dead app only produces noise.
  await Promise.all(session.watchers.map((stop) => stop()))
  await session.app.stop()
  let coreStop: string = 'no core'
  for (const folder of session.dataFolders) {
    const stopped = await stopCore(folder)
    if (stopped !== 'no core') coreStop = stopped
  }
  // Before the profile goes: the journal that names the core's children lives
  // in it, and a core that had to be killed did not stop them.
  for (const folder of session.dataFolders) await reapFakeBackends(folder)
  // The tunnel is in no journal at all; a scenario that started one asserts it is gone, this is the net.
  await reapFakeTunnels(session.profile.root)
  // A stopped core is supposed to have stopped its backends. One that has not
  // holds a model in memory for as long as the machine stays up.
  const leaked = profileProcesses(session.profile.root)
  for (const { pid } of leaked) {
    try {
      process.kill(pid, 'SIGKILL')
    } catch {
      // exited on its own meanwhile
    }
  }
  // Anything but the fixture pack was installed behind the scenario's back —
  // including a half-finished `*.incoming-*` staging folder.
  const foreignBackends = CAN_RUN_FAKE_BACKEND
    ? (await installedBackends(session.profile.dataFolder)).filter((b) => !session.allowedBackends.includes(b))
    : []
  // Likewise a real 34 MB sd.cpp the installer fell back to, or a staging folder a download left.
  const foreignEngines = (await installedImageEngines(session.profile.dataFolder)).filter(
    (engine) => !session.allowedImageEngines.includes(engine)
  )
  await session.profile.destroy()
  return [
    ...foreignBackends.map((b) => `backend installed during the run: ${b}`),
    ...foreignEngines.map((e) => `image engine installed during the run: ${e}`),
    ...leaked.map((p) => `process left running (core: ${coreStop}): ${p.pid} ${p.command.slice(0, 140)}`),
    ...(await operatorStateChanges(session.operatorBefore)),
  ]
}
