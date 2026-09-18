/**
 * One scenario's lifecycle: an isolated profile, the app running on it, a
 * restart that keeps the profile, and an end that proves nothing leaked.
 */
import { freePort, launchApp, type RunningApp } from './app.js'
import { captureFailure } from './artifacts.js'
import { stopCore } from './core.js'
import { reapFakeBackends } from './fixtures.js'
import { listProcesses } from './platform.js'
import { operatorStateChanges, snapshotOperatorState, type OperatorSnapshot } from './invariants.js'
import { createProfile, sweepStaleProfiles, type Profile } from './profile.js'

export interface Session {
  name: string
  profile: Profile
  apiPort: number
  app: RunningApp
  operatorBefore: OperatorSnapshot
  /** Stops every page watcher still running; safe to call twice. */
  watchers: (() => Promise<unknown>)[]
}

export async function startSession(
  name: string,
  options: {
    webviewSeed?: Record<string, string>
    apiServer?: Record<string, unknown>
    prepare?: (profile: Profile) => Promise<void>
  } = {}
): Promise<Session> {
  await sweepStaleProfiles()
  const operatorBefore = await snapshotOperatorState()
  const apiPort = await freePort()
  const profile = await createProfile({
    apiPort,
    apiServer: options.apiServer,
    webviewSeed: options.webviewSeed,
  })
  try {
    await options.prepare?.(profile)
    const app = await launchApp(profile.env)
    return { name, profile, apiPort, app, operatorBefore, watchers: [] }
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
 */
export async function endSession(session: Session): Promise<string[]> {
  // Before the app goes: a watcher left polling a dead app only produces noise.
  await Promise.all(session.watchers.map((stop) => stop()))
  await session.app.stop()
  const coreStop = await stopCore(session.profile.dataFolder)
  // Before the profile goes: the journal that names the core's children lives
  // in it, and a core that had to be killed did not stop them.
  await reapFakeBackends(session.profile.dataFolder)
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
  await session.profile.destroy()
  return [
    ...leaked.map((p) => `process left running (core: ${coreStop}): ${p.pid} ${p.command.slice(0, 140)}`),
    ...(await operatorStateChanges(session.operatorBefore)),
  ]
}
