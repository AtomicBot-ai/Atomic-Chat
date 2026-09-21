/**
 * Every fact the harness knows about the operating system, in one place, so
 * that running the suite on another OS means filling in a branch here rather
 * than finding assumptions scattered through the scenarios.
 *
 * macOS is the only verified platform. The other branches do not guess: a
 * wrong path in the "did we touch the operator's profile" check would make
 * that check pass while protecting nothing, so an unported platform fails
 * loudly and names what it needs.
 */
import { execFileSync } from 'node:child_process'
import { userInfo } from 'node:os'
import { join } from 'node:path'

export const PLATFORM = process.platform

function notPorted(what: string): never {
  throw new Error(
    `the desktop e2e harness is not ported to ${PLATFORM}: ${what}. See tests/e2e/harness/platform.ts.`
  )
}

/** The app binary inside `<target dir>/debug/`. */
export const APP_BINARY_NAME = PLATFORM === 'win32' ? 'Atomic-Chat.exe' : 'Atomic-Chat'

/**
 * Environment variables the app may inherit. Everything else is dropped: the
 * operator's shell may export `CI`, `APP_NAME`, `IS_CLEAN`, `OLLAMA_MODELS` or
 * `HF_HOME`, each of which changes where the app reads or writes.
 */
export function inheritedEnvKeys(): string[] {
  if (PLATFORM === 'win32') {
    // What a Windows process needs to start at all and find system DLLs.
    return ['PATH', 'SystemRoot', 'SystemDrive', 'windir', 'ComSpec', 'PATHEXT', 'TEMP', 'TMP', 'USERNAME']
  }
  return ['PATH', 'TMPDIR', 'LANG', 'USER', 'LOGNAME']
}

/**
 * How the app's idea of "home" is redirected into the profile. It moves
 * everything derived from the home directory that the build's own root does not
 * already own: the local-model scan, the agent CLI configs, `~/Documents`.
 */
export function homeRedirect(home: string): Record<string, string> {
  if (PLATFORM === 'win32') {
    // The `dirs` crate asks the Known Folders API on Windows and ignores these,
    // so they only reach code that reads the environment itself. What that
    // leaves exposed has to be established on a Windows machine.
    return { USERPROFILE: home, APPDATA: join(home, 'AppData', 'Roaming'), LOCALAPPDATA: join(home, 'AppData', 'Local') }
  }
  return { HOME: home }
}

/**
 * Where the run's webview keeps localStorage and IndexedDB, so teardown can
 * remove it. On macOS WebKit keeps a custom data store under the real
 * `~/Library/WebKit/<executable name>` whatever HOME says, named by the UUID the
 * app derives from the root. Elsewhere the app points the webview's data
 * directory inside the root, and it goes away with the root.
 */
export function webviewStoreDir(root: string, storeUuid: string): string {
  if (PLATFORM === 'darwin') {
    return join(userInfo().homedir, 'Library', 'WebKit', 'Atomic-Chat', 'WebsiteDataStore', storeUuid)
  }
  return join(root, 'webview')
}

/**
 * Everything outside the run's root that the app is known to write, watched to
 * prove a run left the operator's own Atomic Chat untouched.
 */
export function operatorPaths(): string[] {
  const home = userInfo().homedir
  if (PLATFORM === 'darwin') {
    return [
      join(home, 'Library', 'Application Support', 'Atomic Chat'),
      join(home, 'Library', 'Application Support', 'chat.atomic.app'),
      join(home, 'Library', 'Application Support', 'chat.atomic.app.e2e'),
      // The default store of every unbundled dev build. A run's own store is a
      // sibling, `WebsiteDataStore/<uuid>`, which is why this is not the parent.
      join(home, 'Library', 'WebKit', 'Atomic-Chat', 'WebsiteData'),
      join(home, 'Library', 'WebKit', 'chat.atomic.app'),
      join(home, 'Documents', 'Atomic_chat'),
      join(home, '.local', 'bin', 'atomic-chat-cli'),
      '/usr/local/bin/atomic-chat-cli',
    ]
  }
  return notPorted(
    'list the real install\'s data folder, app-data folder, webview data folder, CLI install path and Documents sandbox'
  )
}

export interface ProcessEntry {
  pid: number
  command: string
}

/** Every process with its full command line. */
export function listProcesses(): ProcessEntry[] {
  if (PLATFORM === 'win32') {
    return notPorted('list processes with their command lines (e.g. through Get-CimInstance Win32_Process)')
  }
  return execFileSync('ps', ['-axo', 'pid=,command='], { encoding: 'utf8' })
    .split('\n')
    .map((line) => line.trim())
    .filter((line) => line !== '')
    .map((line) => {
      const space = line.indexOf(' ')
      return { pid: Number.parseInt(line.slice(0, space), 10), command: line.slice(space + 1) }
    })
    .filter((entry) => Number.isInteger(entry.pid))
}

/**
 * The socket the single-instance plugin leaves behind when its app is killed,
 * which is the only way a test can end one. Named after the run's identifier
 * (`run_identifier` in src-tauri/src/core/e2e.rs). Unix only: on Windows the
 * plugin holds a mutex, which goes with the process.
 */
export function singleInstanceSocket(identifier: string): string | null {
  if (PLATFORM === 'win32') return null
  return `/tmp/${identifier.replace(/[.-]/g, '_')}_si.sock`
}

/** The processes listening on a loopback TCP port. */
export function listenersOn(port: number): number[] {
  if (PLATFORM === 'win32') {
    return notPorted('find the process listening on a port (e.g. through Get-NetTCPConnection)')
  }
  try {
    return execFileSync('lsof', ['-nP', `-iTCP:${port}`, '-sTCP:LISTEN', '-t'], { encoding: 'utf8' })
      .split('\n')
      .map((line) => Number.parseInt(line.trim(), 10))
      .filter((pid) => Number.isInteger(pid))
  } catch {
    return [] // lsof exits 1 when nothing listens there
  }
}

/**
 * The core's scripted fake llama-server is installed as a `#!/bin/sh` launcher,
 * which Windows cannot execute as `llama-server.exe`. Scenarios that need it are
 * skipped there; the real-backend scenario is the portable one.
 */
export const CAN_RUN_FAKE_BACKEND = PLATFORM !== 'win32'
