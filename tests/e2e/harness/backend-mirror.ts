/**
 * A release of the llama.cpp backend, published on this machine. Neither the
 * app nor the core lets the address of the backend manifest be changed, but
 * both honour the user's proxy setting, so the mirror is reached the way a
 * corporate network would reach GitHub: a CONNECT proxy on loopback that leads
 * every host to one local HTTPS origin. That origin answers for the manifest
 * and for the archive the manifest names.
 *
 * The archive holds the core's scripted `llama-server` with its own reply, so a
 * chat afterwards tells which backend answered. It also answers `--version`,
 * which the core asks an installed binary on macOS before accepting it. The
 * same archive serves the scenario that installs a backend from a file.
 */
import { execFile } from 'node:child_process'
import { createHash } from 'node:crypto'
import { chmod, mkdir, mkdtemp, readFile, rm, writeFile } from 'node:fs/promises'
import { createServer as createHttpServer } from 'node:http'
import { createServer as createHttpsServer } from 'node:https'
import { connect, type Socket } from 'node:net'
import { tmpdir } from 'node:os'
import { basename, join } from 'node:path'
import { promisify } from 'node:util'
import { CORE_REPO, FAKE_BACKEND } from './fixtures.js'

const run = promisify(execFile)

export interface BackendMirror {
  /** `provider`-less id of what it publishes, e.g. `b99999/macos-arm64`. */
  versionBackend: string
  /** The value for the app's proxy URL setting. */
  proxyUrl: string
  /** Every CONNECT the proxy saw and every request the origin served, in order. */
  seen: () => string[]
  stop: () => Promise<void>
}

/**
 * Packs the scripted backend as a release archive, named the way llama.cpp
 * names its macOS builds, into `dir`. Returns the archive's path.
 */
export async function buildBackendArchive(dir: string, options: { tag: string; reply: string }): Promise<string> {
  const build = options.tag.replace(/^b/, '')
  const source = join(dir, 'archive-source')
  const bin = join(source, 'build', 'bin')
  await mkdir(bin, { recursive: true })
  const script = join(CORE_REPO, 'test', 'helpers', 'fake-llama-server.mjs')
  await writeFile(
    join(bin, 'llama-server'),
    [
      '#!/bin/sh',
      `if [ "$1" = "--version" ]; then echo "version: ${build} (e2e fixture)"; exit 0; fi`,
      `export FAKE_LLAMA_MODE=ready FAKE_LLAMA_REPLY=${JSON.stringify(options.reply)}`,
      `exec ${JSON.stringify(process.execPath)} ${JSON.stringify(script)} "$@"`,
      '',
    ].join('\n')
  )
  await chmod(join(bin, 'llama-server'), 0o755)
  const archive = join(dir, `llama-${options.tag}-bin-${FAKE_BACKEND}.tar.gz`)
  await run('tar', ['-czf', archive, '-C', source, 'build'])
  return archive
}

export async function startBackendMirror(options: {
  /** Release tag, `b` and digits. */
  tag: string
  /** What the published backend replies in a chat. */
  reply: string
  /** Publish a manifest whose checksum does not match the archive. */
  badChecksum?: boolean
}): Promise<BackendMirror> {
  // Not the profiles' prefix: the sweep before a session removes those.
  const work = await mkdtemp(join(tmpdir(), 'atomic-mirror-e2e-'))
  const archivePath = await buildBackendArchive(work, options)
  const archiveName = basename(archivePath)
  const archive = await readFile(archivePath)
  const manifest = Buffer.from(
    JSON.stringify({
      tag_name: options.tag,
      download_base: 'https://mirror.atomic.invalid/releases',
      assets: [
        {
          name: archiveName,
          size: archive.length,
          sha256: options.badChecksum ? '0'.repeat(64) : createHash('sha256').update(archive).digest('hex'),
        },
      ],
    })
  )

  const seen: string[] = []
  const tls = join(CORE_REPO, 'test', 'fixtures', 'tls')
  const origin = createHttpsServer(
    { key: await readFile(join(tls, 'server.key')), cert: await readFile(join(tls, 'server.pem')) },
    (req, res) => {
      seen.push(`${req.method} ${req.headers.host}${req.url}`)
      const content = req.url?.endsWith('/backends/manifest.json')
        ? manifest
        : req.url?.endsWith(`/${options.tag}/${archiveName}`)
          ? archive
          : null
      if (!content) return void res.writeHead(404).end()
      res.writeHead(200, {
        'content-length': content.length,
        'content-type': content === manifest ? 'application/json' : 'application/octet-stream',
      })
      res.end(req.method === 'HEAD' ? undefined : content)
    }
  )
  // Whatever host is asked for, the tunnel ends at the mirror. A plain request
  // through the proxy is not something the mirror stands in for.
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

  return {
    versionBackend: `${options.tag}/${FAKE_BACKEND}`,
    proxyUrl: `http://127.0.0.1:${proxyPort}`,
    seen: () => [...seen],
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all([origin, proxy].map((server) => new Promise<void>((resolve) => server.close(() => resolve()))))
      await rm(work, { recursive: true, force: true })
    },
  }
}

/** The app's proxy setting as the webview persists it, pointing at the mirror. */
export function proxySeed(proxyUrl: string): Record<string, string> {
  return {
    'setting-proxy-config': JSON.stringify({
      state: {
        proxyEnabled: true,
        proxyUrl,
        proxyUsername: '',
        proxyPassword: '',
        // The mirror's certificate is the core's test one, for no real host.
        proxyIgnoreSSL: true,
        verifyProxySSL: false,
        verifyProxyHostSSL: false,
        verifyPeerSSL: false,
        verifyHostSSL: false,
        noProxy: '',
      },
      version: 0,
    }),
  }
}
