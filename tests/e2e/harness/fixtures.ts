/**
 * What a scenario puts into a profile before the app starts: a llama.cpp
 * backend that is really the core's scripted fake, and a model for it to "load".
 *
 * The fake backend and the child reaper come from the sibling `atomic-chat-core`
 * checkout, the way `make test-core-live` takes its binary from there: they are
 * the core's own test doubles, and copying them here would let the copy drift
 * from the process protocol the core actually expects.
 */
import { cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Profile } from './profile.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
const CORE_REPO = process.env.ATOMIC_CORE_REPO ?? resolve(REPO_ROOT, '../atomic-chat-core')

async function coreHelper<T>(file: string): Promise<T> {
  return (await import(/* @vite-ignore */ pathToFileURL(join(CORE_REPO, file)).href)) as T
}

/**
 * Higher than any real llama.cpp tag. After launch the upstream extension
 * compares the configured backend with the newest one it knows — the remote
 * catalog merged with what is installed — and silently downloads the newer.
 * With the fake as the newest there is never anything to move to, whatever the
 * catalog holds that day. It also keeps clear of the bundled pair, whose binary
 * the app probes with `--version`, a flag the fake does not answer.
 */
export const FAKE_BACKEND_VERSION = 'b99999'
export const FAKE_BACKEND = 'macos-arm64'
export const FAKE_PROVIDER = 'llamacpp-upstream'

export interface FakeBackendOptions {
  /** The exact text the fake streams back, one word per chunk. */
  reply?: string
  /** `ready` by default; `exit-1` makes every load fail. */
  mode?: string
}

export async function installFakeBackend(
  profile: Profile,
  options: FakeBackendOptions = {}
): Promise<void> {
  const config = await coreHelper<{ dataLayout: (root: string) => unknown }>('src/config/index.ts')
  const pack = await coreHelper<{
    installFakeBackend: (layout: unknown, options: Record<string, unknown>) => Promise<unknown>
  }>('test/helpers/fake-backend-pack.ts')
  await pack.installFakeBackend(config.dataLayout(profile.dataFolder), {
    provider: FAKE_PROVIDER,
    version: FAKE_BACKEND_VERSION,
    backend: FAKE_BACKEND,
    ...options,
  })
}

/**
 * A model directory the app lists and the core loads. The weights are filler:
 * neither side needs a GGUF header for a text model, only a file as large as
 * `model_size_bytes` says. `embedding: false` keeps the extension from trying
 * to read metadata out of that filler to find out.
 */
export async function writeFakeModel(profile: Profile, modelId: string): Promise<void> {
  const dir = join(profile.dataFolder, 'llamacpp', 'models', ...modelId.split('/'))
  await mkdir(dir, { recursive: true })
  await writeFile(join(dir, 'model.gguf'), Buffer.alloc(64, 0x47))
  await writeFile(
    join(dir, 'model.yml'),
    [
      `model_path: llamacpp/models/${modelId}/model.gguf`,
      `name: ${modelId}`,
      'size_bytes: 64',
      'model_size_bytes: 64',
      'embedding: false',
      '',
    ].join('\n')
  )
}

/**
 * A real llama.cpp backend and a real model, for the opt-in scenario that
 * proves what the fake cannot: the argv the core builds is one llama-server
 * accepts, its readiness output is recognised, and tokens come back. Both are
 * taken from paths the operator names and are only read. The backend directory
 * (the one holding `build/`) is copied into the profile under the same
 * newest-possible version as the fake, for the same reason: the app replaces an
 * older backend with a downloaded one. The model is referenced by absolute
 * path, which the app supports for models it finds in other tools' caches.
 */
export const REAL_BACKEND_DIR = process.env.ATOMIC_E2E_LLAMA_BACKEND_DIR
export const REAL_MODEL_GGUF = process.env.ATOMIC_E2E_MODEL_GGUF

export async function installRealBackend(profile: Profile, backendDir: string): Promise<void> {
  const target = join(profile.dataFolder, FAKE_PROVIDER, 'backends', FAKE_BACKEND_VERSION, FAKE_BACKEND)
  await mkdir(dirname(target), { recursive: true })
  // Versioned dylibs are symlinks to one file; keep them that way.
  await cp(backendDir, target, { recursive: true, verbatimSymlinks: true })
}

export async function writeRealModel(profile: Profile, modelId: string, ggufPath: string): Promise<void> {
  const dir = join(profile.dataFolder, 'llamacpp', 'models', ...modelId.split('/'))
  await mkdir(dir, { recursive: true })
  const { size } = await stat(ggufPath)
  await writeFile(
    join(dir, 'model.yml'),
    [`model_path: ${ggufPath}`, `name: ${modelId}`, `size_bytes: ${size}`, 'embedding: false', ''].join('\n')
  )
}

/** Kills fake backends the core journalled but did not get to stop. */
export async function reapFakeBackends(dataFolder: string): Promise<void> {
  const core = await coreHelper<{ reapJournalledChildren: (dataFolder: string) => void }>(
    'test/helpers/compiled-core.ts'
  )
  core.reapJournalledChildren(dataFolder)
}

/**
 * Every `<version>/<backend>` installed under the profile, per provider. A run
 * that downloaded a real backend behind the test's back shows up here.
 */
export async function installedBackends(dataFolder: string): Promise<string[]> {
  const found: string[] = []
  for (const provider of ['llamacpp', 'llamacpp-upstream']) {
    const root = join(dataFolder, provider, 'backends')
    for (const version of await readdir(root).catch(() => [] as string[])) {
      for (const backend of await readdir(join(root, version)).catch(() => [] as string[])) {
        found.push(`${provider}:${version}/${backend}`)
      }
    }
  }
  return found.sort()
}
