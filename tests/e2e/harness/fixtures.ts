/**
 * What a scenario puts into a profile before the app starts: a llama.cpp
 * backend that is really the core's scripted fake, and a model for it to "load".
 *
 * The fake backend and the child reaper come from the sibling `atomic-chat-core`
 * checkout, the way `make test-core-live` takes its binary from there: they are
 * the core's own test doubles, and copying them here would let the copy drift
 * from the process protocol the core actually expects.
 */
import { once } from 'node:events'
import { createServer } from 'node:http'
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

export interface CloudRequest {
  method: string
  path: string
  /** What came in the Authorization header, verbatim; '' when absent. */
  authorization: string
  status: number
}

export interface FakeCloud {
  baseUrl: string
  /** Every request the endpoint received, in order. */
  requests: () => CloudRequest[]
  stop: () => Promise<void>
}

/**
 * A stand-in for a cloud provider: an OpenAI-compatible endpoint on loopback,
 * inside the test process so that a test can read what was sent to it. It
 * answers 401 without the right bearer key, lists one model and streams a fixed
 * reply — all a provider has to do for the app to connect and chat.
 */
export async function startFakeCloud(options: {
  apiKey: string
  model: string
  reply: string
}): Promise<FakeCloud> {
  const seen: CloudRequest[] = []
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    const authorization = req.headers.authorization ?? ''
    const finish = (status: number, headers: Record<string, string>, body: string) => {
      seen.push({ method: req.method ?? '', path, authorization, status })
      res.writeHead(status, headers)
      res.end(body)
    }
    const json = (status: number, body: unknown) =>
      finish(status, { 'content-type': 'application/json' }, JSON.stringify(body))

    let raw = ''
    req.on('data', (chunk: Buffer) => (raw += chunk.toString()))
    req.on('end', () => {
      if (authorization !== `Bearer ${options.apiKey}`) {
        return json(401, { error: { message: 'Incorrect API key provided', type: 'invalid_request_error' } })
      }
      if (req.method === 'GET' && path === '/v1/models') {
        return json(200, { object: 'list', data: [{ id: options.model, object: 'model', owned_by: 'e2e' }] })
      }
      if (req.method === 'POST' && path === '/v1/chat/completions') {
        const wantsStream = (JSON.parse(raw || '{}') as { stream?: boolean }).stream === true
        const chunk = (delta: object, finishReason: string | null) => ({
          id: 'chatcmpl-e2e',
          object: 'chat.completion.chunk',
          created: 1_700_000_000,
          model: options.model,
          choices: [{ index: 0, delta, finish_reason: finishReason }],
        })
        if (!wantsStream) {
          return json(200, {
            id: 'chatcmpl-e2e',
            object: 'chat.completion',
            created: 1_700_000_000,
            model: options.model,
            choices: [{ index: 0, message: { role: 'assistant', content: options.reply }, finish_reason: 'stop' }],
            usage: { prompt_tokens: 3, completion_tokens: 3, total_tokens: 6 },
          })
        }
        const words = options.reply.split(' ')
        const frames = [
          ...words.map((word, i) => chunk(i === 0 ? { role: 'assistant', content: word } : { content: ` ${word}` }, null)),
          chunk({}, 'stop'),
        ].map((frame) => `data: ${JSON.stringify(frame)}\n\n`)
        return finish(200, { 'content-type': 'text/event-stream' }, `${frames.join('')}data: [DONE]\n\n`)
      }
      return json(404, { error: { message: `no route for ${req.method} ${path}` } })
    })
  })
  server.listen(0, '127.0.0.1')
  await once(server, 'listening')
  const address = server.address()
  const port = typeof address === 'object' && address ? address.port : 0
  return {
    baseUrl: `http://127.0.0.1:${port}/v1`,
    requests: () => [...seen],
    stop: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
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
