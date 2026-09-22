/**
 * A release of the image engine and a Hugging Face model, published on this
 * machine. The app fetches the engine from GitHub and models from Hugging Face
 * at addresses it does not let anyone change, but every download honours the
 * user's proxy setting: a CONNECT proxy on loopback leads every host to one
 * local HTTPS origin, which answers for the archive and the model files — the
 * same trick `backend-mirror.ts` plays for llama.cpp.
 *
 * The archive holds the core's scripted `sd-server` (its `--help` prints the
 * flag the core's finalize probe looks for) and an `sd-cli` beside it.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { mkdir, mkdtemp, readFile, rm } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { join } from 'node:path'
import { promisify } from 'node:util'
import { CORE_REPO } from './fixtures.js'
import type { FakeSdOptions } from './images.js'

const run = promisify(execFile)

async function coreHelper<T>(file: string): Promise<T> {
  const { pathToFileURL } = await import('node:url')
  return (await import(/* @vite-ignore */ pathToFileURL(join(CORE_REPO, file)).href)) as T
}

export interface EngineArchive {
  path: string
  name: string
  sha256: string
  size: number
}

/** Packs the scripted engine as the release zip the manifest names, into `dir`. */
export async function buildImageEngineArchive(
  dir: string,
  options: { name: string } & FakeSdOptions
): Promise<EngineArchive> {
  const fake = await coreHelper<{ writeFakeSdLaunchers: (dir: string, options: Record<string, unknown>) => Promise<void> }>(
    'test/helpers/fake-sd-server.ts'
  )
  const source = join(dir, 'engine-source')
  const { name, ...fakeOptions } = options
  await fake.writeFakeSdLaunchers(source, { stepMs: 150, ...fakeOptions })
  const path = join(dir, name)
  await run('zip', ['-j', '-q', path, join(source, 'sd-server'), join(source, 'sd-cli')])
  const bytes = await readFile(path)
  return { path, name, sha256: createHash('sha256').update(bytes).digest('hex'), size: bytes.length }
}

export interface ImageMirror {
  /** The value for the app's proxy URL setting. */
  proxyUrl: string
  /** Every CONNECT the proxy saw and every request the origin served, in order. */
  seen: () => string[]
  stop: () => Promise<void>
}

/**
 * Serves `files` (URL path → bytes) from one HTTPS origin behind a CONNECT
 * proxy, whatever host the client asked for. A path not listed is a 404, which
 * is what a download the scenario did not expect turns into.
 */
export async function startImageMirror(files: Record<string, Buffer>): Promise<ImageMirror> {
  const work = await mkdtemp(join(tmpdir(), 'atomic-image-mirror-e2e-'))
  const seen: string[] = []
  const tls = join(CORE_REPO, 'test', 'fixtures', 'tls')
  const origin = createHttpsServer(
    { key: await readFile(join(tls, 'server.key')), cert: await readFile(join(tls, 'server.pem')) },
    (req, res) => {
      // The model files come from Hugging Face, where a token must not travel: note whether one did.
      seen.push(`${req.method} ${req.headers.host}${req.url}${req.headers.authorization ? ' (with authorization)' : ''}`)
      const path = (req.url ?? '/').split('?')[0]
      const content = files[path]
      if (!content) return void res.writeHead(404).end()
      const range = /^bytes=(\d+)-(\d*)$/.exec(req.headers.range ?? '')
      if (range) {
        const start = Number(range[1])
        const end = range[2] ? Number(range[2]) : content.length - 1
        res.writeHead(206, {
          'content-range': `bytes ${start}-${end}/${content.length}`,
          'content-length': end - start + 1,
          'accept-ranges': 'bytes',
          'content-type': 'application/octet-stream',
        })
        return void res.end(req.method === 'HEAD' ? undefined : content.subarray(start, end + 1))
      }
      res.writeHead(200, {
        'content-length': content.length,
        'accept-ranges': 'bytes',
        'content-type': 'application/octet-stream',
      })
      res.end(req.method === 'HEAD' ? undefined : content)
    }
  )
  const proxy = createHttpServer((_req, res) => void res.writeHead(502).end())
  const sockets = new Set<Socket>()
  proxy.on('connect', (req, socket: Socket, head: Buffer) => {
    seen.push(`CONNECT ${req.url}`)
    const upstream = connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  for (const server of [origin, proxy])
    server.on('connection', (socket: Socket) => {
      sockets.add(socket)
      socket.once('close', () => sockets.delete(socket))
    })
  const listen = (server: typeof origin | typeof proxy) =>
    new Promise<number>((resolve) =>
      server.listen(0, '127.0.0.1', () => {
        const address = server.address()
        resolve(typeof address === 'object' && address ? address.port : 0)
      })
    )
  const originPort = await listen(origin)
  const proxyPort = await listen(proxy)
  await mkdir(work, { recursive: true })
  return {
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    seen: () => [...seen],
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([origin, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      await rm(work, { recursive: true, force: true })
    },
  }
}
