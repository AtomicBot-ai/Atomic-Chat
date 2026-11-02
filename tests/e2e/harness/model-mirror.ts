/** Local TLS origin reached through the app's existing HF proxy transport. */
import { readFile } from 'node:fs/promises'
import { createServer as http, type RequestListener } from 'node:http'
import { createServer as https } from 'node:https'
import { connect, type Socket } from 'node:net'
import { join } from 'node:path'
import { CORE_REPO } from './fixtures.js'

export async function startModelMirror(handler: RequestListener) {
  const tls = join(CORE_REPO, 'test', 'fixtures', 'tls')
  const origin = https(
    {
      key: await readFile(join(tls, 'server.key')),
      cert: await readFile(join(tls, 'server.pem')),
    },
    handler
  )
  const proxy = http((_req, res) => void res.writeHead(502).end())
  const sockets = new Set<Socket>()
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
  proxy.on('connect', (_req, socket: Socket, head: Buffer) => {
    const upstream = connect(originPort, '127.0.0.1', () => {
      socket.write('HTTP/1.1 200 Connection Established\r\n\r\n')
      if (head.length) upstream.write(head)
      socket.pipe(upstream)
      upstream.pipe(socket)
    })
    sockets.add(upstream)
    upstream.once('close', () => sockets.delete(upstream))
    upstream.on('error', () => socket.destroy())
    socket.on('error', () => upstream.destroy())
  })
  const port = await listen(proxy)
  return {
    proxyUrl: `http://127.0.0.1:${port}`,
    stop: async () => {
      for (const socket of sockets) socket.destroy()
      await Promise.all(
        [origin, proxy].map(
          (server) =>
            new Promise<void>((resolve) => server.close(() => resolve()))
        )
      )
    },
  }
}
