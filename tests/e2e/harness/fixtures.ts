/**
 * What a scenario puts into a profile before the app starts: a llama.cpp
 * backend that is really the core's scripted fake, and a model for it to "load".
 *
 * The fake backend and the child reaper come from the sibling `atomic-chat-core`
 * checkout, the way `make test-core-live` takes its binary from there: they are
 * the core's own test doubles, and copying them here would let the copy drift
 * from the process protocol the core actually expects.
 */
import { createHash } from 'node:crypto'
import { once } from 'node:events'
import { createServer } from 'node:http'
import { appendFile, cp, mkdir, readdir, stat, writeFile } from 'node:fs/promises'
import { dirname, join, resolve } from 'node:path'
import { fileURLToPath, pathToFileURL } from 'node:url'
import type { Profile } from './profile.js'

const REPO_ROOT = resolve(dirname(fileURLToPath(import.meta.url)), '../../..')
export const CORE_REPO = process.env.ATOMIC_CORE_REPO ?? resolve(REPO_ROOT, '../atomic-chat-core')

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
  /** The release tag to install it as; `FAKE_BACKEND_VERSION` unless a scenario needs an older one. */
  version?: string
  /** The local provider to install it for; the upstream llama.cpp one unless a scenario runs another. */
  provider?: string
  /** Scripted answers of the raw `/completion` endpoint, in order — what an agent loop reads its steps from. `{{seen:TEXT}}` becomes yes/no: whether the prompt held TEXT. */
  completionSteps?: string[]
  /** One scripted tool turn: call this tool when the app offers it, then repeat its result after the reply. */
  toolCall?: { name: string; arguments?: Record<string, unknown> }
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

/** A GGUF file with no tensors and the given string metadata — all the app ever reads from one. */
function ggufWith(metadata: Record<string, string>): Buffer {
  const text = (value: string) => {
    const bytes = Buffer.from(value, 'utf8')
    const length = Buffer.alloc(8)
    length.writeBigUInt64LE(BigInt(bytes.length))
    return Buffer.concat([length, bytes])
  }
  const header = Buffer.alloc(24)
  header.write('GGUF', 0, 'ascii')
  header.writeUInt32LE(3, 4) // version
  header.writeBigUInt64LE(0n, 8) // tensor count
  header.writeBigUInt64LE(BigInt(Object.keys(metadata).length), 16)
  const stringType = Buffer.alloc(4)
  stringType.writeUInt32LE(8)
  return Buffer.concat([
    header,
    ...Object.entries(metadata).flatMap(([key, value]) => [text(key), stringType, text(value)]),
  ])
}

export interface FakeModelOptions {
  /**
   * Give the file a chat template that mentions tools. The app decides from the
   * template whether a model can call tools, and offers document attachments
   * only for one that can.
   */
  tools?: boolean
  /** Mark it as an embedding model, which the core then loads with `--embedding`. */
  embedding?: boolean
}

/**
 * A model directory the app lists and the core loads. By default the weights
 * are filler: neither side needs a GGUF header for a text model, only a file as
 * large as `model_size_bytes` says. `embedding` is always written, which keeps
 * the extension from trying to read metadata out of that filler to find out.
 */
export async function writeFakeModel(profile: Profile, modelId: string, options: FakeModelOptions = {}): Promise<void> {
  const dir = join(profile.dataFolder, 'llamacpp', 'models', ...modelId.split('/'))
  await mkdir(dir, { recursive: true })
  const weights = options.tools
    ? ggufWith({ 'general.architecture': 'llama', 'tokenizer.chat_template': '{{ messages }}{% if tools %}{{ tools }}{% endif %}' })
    : Buffer.alloc(64, 0x47)
  await writeFile(join(dir, 'model.gguf'), weights)
  await writeFile(
    join(dir, 'model.yml'),
    [
      `model_path: llamacpp/models/${modelId}/model.gguf`,
      `name: ${modelId}`,
      `size_bytes: ${weights.length}`,
      `model_size_bytes: ${weights.length}`,
      `embedding: ${options.embedding === true}`,
      '',
    ].join('\n')
  )
}

/**
 * The model the app embeds documents with. It is looked up by this id and, when
 * missing, downloaded from Hugging Face on first use; placing it keeps a run
 * off the network.
 */
export const EMBEDDING_MODEL_ID = 'sentence-transformer-mini'

export interface CloudRequest {
  method: string
  path: string
  /** What came in the Authorization header, verbatim; '' when absent. */
  authorization: string
  status: number
}

export interface CloudCompletion {
  model?: string
  stream?: boolean
  messages?: { role?: string; content?: unknown }[]
}

export interface FakeCloud {
  baseUrl: string
  /** Every request the endpoint received, in order. */
  requests: () => CloudRequest[]
  /** Completion payloads received from the app and outside API clients. */
  completions: () => CloudCompletion[]
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
  const completions: CloudCompletion[] = []
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
        const completion = JSON.parse(raw || '{}') as CloudCompletion
        completions.push(completion)
        const wantsStream = completion.stream === true
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
    completions: () => [...completions],
    stop: async () => {
      server.closeAllConnections()
      server.close()
      await once(server, 'close')
    },
  }
}

/** The port baked into the e2e build as the Hub's catalog and picks address (Makefile: E2E_FIXTURE_PORT). */
export const HUB_FIXTURE_PORT = Number(process.env.ATOMIC_E2E_FIXTURE_PORT ?? 47391)

export interface HubFixtureRequest {
  method: string
  path: string
  authorization: string
  /** The `Range` header, empty when the whole file was asked for. */
  range: string
}

export interface HubFixture {
  modelBytes: number
  /** sha256 of the model file, to compare with what landed on disk. */
  modelSha256: string
  requests: () => HubFixtureRequest[]
  stop: () => Promise<void>
}

/**
 * What the Hub needs to offer one model and let it be downloaded, served from
 * this machine: the catalog, the landing page's picks, and the model file. The
 * file is a real GGUF as far as the importer looks — magic, version, no tensors,
 * no metadata — padded out, and sent slowly, because the app reports progress
 * once per 10 MB and a file that arrives at once shows none. The padding counts
 * its own position, so a resumed transfer written at the wrong offset changes
 * the file's hash instead of vanishing among zeros.
 */
export async function startHubFixture(options: {
  modelName: string
  quantId: string
  title: string
  modelBytes?: number
}): Promise<HubFixture> {
  const modelBytes = options.modelBytes ?? 32 * 1024 * 1024
  const origin = `http://127.0.0.1:${HUB_FIXTURE_PORT}`
  const header = Buffer.alloc(24)
  header.write('GGUF', 0, 'ascii')
  header.writeUInt32LE(3, 4) // version
  header.writeBigUInt64LE(0n, 8) // tensor count
  header.writeBigUInt64LE(0n, 16) // metadata key-value count
  const model = Buffer.alloc(modelBytes)
  for (let at = header.length; at + 4 <= modelBytes; at += 4) model.writeUInt32LE(at, at)
  header.copy(model)

  const catalog = {
    manifest_version: 1,
    schema_version: 1,
    updated_at: '2026-01-01T00:00:00Z',
    models: [
      {
        model_name: options.modelName,
        developer: 'e2e',
        description: 'A fixture model served by the desktop e2e suite.',
        downloads: 0,
        num_quants: 1,
        quants: [{ model_id: options.quantId, path: `${origin}/model.gguf`, file_size: '0.03 GB' }],
        num_mmproj: 0,
        mmproj_models: [],
        num_safetensors: 0,
        safetensors_files: [],
        is_mlx: false,
      },
    ],
  }
  const picks = {
    schema_version: 1,
    updated_at: '2026-01-01T00:00:00Z',
    picks: [{ model_name: options.modelName, title: options.title, summary: 'Fixture pick.', format: 'gguf', order: 1, active: true }],
  }

  const seen: HubFixtureRequest[] = []
  const server = createServer((req, res) => {
    const path = (req.url ?? '').split('?')[0] ?? ''
    seen.push({
      method: req.method ?? '',
      path,
      authorization: req.headers.authorization ?? '',
      range: req.headers.range ?? '',
    })
    const json = (body: unknown) => {
      res.writeHead(200, { 'content-type': 'application/json', 'access-control-allow-origin': '*' })
      res.end(JSON.stringify(body))
    }
    if (path === '/catalog.json') return json(catalog)
    if (path === '/staff-picks.json') return json(picks)
    if (path === '/model.gguf') {
      const range = /^bytes=(\d+)-/.exec(req.headers.range ?? '')
      const from = range ? Number(range[1]) : 0
      res.writeHead(range ? 206 : 200, {
        'content-type': 'application/octet-stream',
        'content-length': String(model.length - from),
        'accept-ranges': 'bytes',
        ...(range ? { 'content-range': `bytes ${from}-${model.length - 1}/${model.length}` } : {}),
      })
      if (req.method === 'HEAD') return res.end()
      // A megabyte every 150 ms: about five seconds for the default size, so
      // each of the app's 10 MB progress reports stays on screen long enough to
      // be read.
      let offset = from
      const pump = () => {
        if (res.destroyed) return
        if (offset >= model.length) return res.end()
        const end = Math.min(offset + 1024 * 1024, model.length)
        res.write(model.subarray(offset, end))
        offset = end
        setTimeout(pump, 150)
      }
      return pump()
    }
    // Including the `.gz` twins the app asks for first.
    res.writeHead(404, { 'access-control-allow-origin': '*' })
    res.end()
  })
  await new Promise<void>((resolve, reject) => {
    server.once('error', (error) =>
      reject(new Error(`the Hub fixture could not listen on ${origin}: ${String(error)}. The port is baked into the e2e build.`))
    )
    server.listen(HUB_FIXTURE_PORT, '127.0.0.1', resolve)
  })
  return {
    modelBytes: model.length,
    modelSha256: createHash('sha256').update(model).digest('hex'),
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

/**
 * Queues what the next native file dialog will "return". An e2e build never
 * opens one: it takes the next queued answer, or behaves as if the user
 * cancelled when there is none.
 */
export async function answerNextDialog(profile: Profile, answer: string | string[] | null): Promise<void> {
  await appendFile(join(profile.root, 'dialog-answers.jsonl'), `${JSON.stringify(answer)}\n`)
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
