/**
 * A test run's whole world: one temporary root holding the app configuration,
 * the data folder and a stand-in home directory, plus the one thing that on
 * macOS cannot live under it — the run's WebKit data store (see platform.ts).
 */
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readdir, realpath, rm, writeFile } from 'node:fs/promises'
import { tmpdir } from 'node:os'
import { delimiter, join } from 'node:path'
import { homeRedirect, listProcesses, webviewStoreDir } from './platform.js'

export interface Profile {
  root: string
  home: string
  dataFolder: string
  /** First on the app's PATH: where a scenario puts stand-ins for tools the app looks for. */
  binDir: string
  /** Where the webview keeps this run's localStorage and IndexedDB. */
  webviewStore: string
  /** What the app needs in its environment to live inside this profile. */
  env: Record<string, string>
  destroy: () => Promise<void>
}

/**
 * Mirrors `webview_data_store` in src-tauri/src/core/e2e.rs: the first 16 bytes
 * of SHA-256 over the root path, rendered the way WebKit names a data store.
 */
export function webviewStoreUuid(root: string): string {
  const hex = createHash('sha256').update(root).digest('hex').slice(0, 32)
  return [hex.slice(0, 8), hex.slice(8, 12), hex.slice(12, 16), hex.slice(16, 20), hex.slice(20, 32)].join('-')
}

const ROOT_PREFIX = 'atomic-e2e-'

/**
 * Removes what an interrupted run left behind: its root and, on macOS, its
 * WebKit store outside the root. A run killed from outside never reaches its own
 * teardown, and the stores would otherwise pile up in the operator's Library. A
 * root still named on some process's command line belongs to a run in progress
 * (or to a core that outlived it) and is left alone.
 */
export async function sweepStaleProfiles(): Promise<string[]> {
  const temp = await realpath(tmpdir())
  const commands = listProcesses().map((p) => p.command)
  const removed: string[] = []
  for (const name of await readdir(temp)) {
    if (!name.startsWith(ROOT_PREFIX)) continue
    const root = join(temp, name)
    if (commands.some((command) => command.includes(root))) continue
    await rm(root, { recursive: true, force: true })
    await rm(webviewStoreDir(root, webviewStoreUuid(root)), { recursive: true, force: true })
    removed.push(root)
  }
  return removed
}

export interface ProfileOptions {
  /** A free port for the local API server, so a test never reaches for 1337. */
  apiPort: number
  /** Further local API server settings, merged over the app's defaults (e.g. `apiKey`). */
  apiServer?: Record<string, unknown>
  /** Extra localStorage entries, key to stored string, written before the first page script. */
  webviewSeed?: Record<string, string>
}

export async function createProfile(options: ProfileOptions): Promise<Profile> {
  // realpath: on macOS the temp dir is a symlink, and the app reports resolved paths.
  const root = await realpath(await mkdtemp(join(tmpdir(), ROOT_PREFIX)))
  const home = join(root, 'home')
  const dataFolder = join(root, 'data')
  const binDir = join(root, 'bin')
  await mkdir(home, { recursive: true })
  await mkdir(dataFolder, { recursive: true })
  await mkdir(binDir, { recursive: true })

  // A first launch otherwise connects to a hosted MCP server (one default
  // server ships enabled) and creates ~/Documents/Atomic_chat. An existing
  // config with no servers, marked as already migrated, prevents both.
  await writeFile(join(dataFolder, 'mcp_config.json'), JSON.stringify({ mcpServers: {} }))
  await writeFile(join(dataFolder, 'store.json'), JSON.stringify({ mcp_version: 3 }))

  // The webview reads these while booting, before a test could change them in
  // the UI. By default the local API server starts with the app and binds 1337,
  // the port of the operator's own Atomic Chat. Shape and version follow the
  // persisted store in web-app/src/hooks/useLocalApiServer.ts; a partial state
  // merges over the defaults.
  const seed: Record<string, string> = {
    'setting-local-api-server': JSON.stringify({
      state: { ...options.apiServer, enableOnStartup: false, serverPort: options.apiPort },
      version: 3,
    }),
    ...options.webviewSeed,
  }
  await writeFile(join(root, 'webview-seed.json'), JSON.stringify(seed))

  const webviewStore = webviewStoreDir(root, webviewStoreUuid(root))
  const env: Record<string, string> = {
    ...homeRedirect(home),
    ATOMIC_E2E_DATA_ROOT: root,
    PATH: `${binDir}${delimiter}${process.env.PATH ?? ''}`,
  }
  // Which core the app starts: `make test-app-e2e` names one, otherwise the app
  // falls back to the one bundled with the build. Quoted because the app splits
  // the override like a command line and the path may contain spaces.
  const coreBinary = process.env.ATOMIC_CORE_BIN
  if (coreBinary) env.ATOMIC_CORE_CMD = `"${coreBinary}"`
  return {
    root,
    home,
    dataFolder,
    binDir,
    webviewStore,
    env,
    destroy: async () => {
      await rm(root, { recursive: true, force: true })
      await rm(webviewStore, { recursive: true, force: true })
    },
  }
}
