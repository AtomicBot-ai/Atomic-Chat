/**
 * Is this address Atomic Chat's own Local API Server?
 *
 * Every remote provider is reached through that server's proxy, so an
 * endpoint that points back at it sends each request round the proxy and
 * back again: its "model list" is the app's own `/v1/models`, and a chat
 * through it waits until it is stopped. Such an address is refused where an
 * endpoint is saved and where one is checked.
 *
 * The comparison is by host and port, never by path: any path on the
 * server's port is the server.
 */

import { useLocalApiServer } from '@/hooks/useLocalApiServer'

export type LocalApiServerAddress = {
  serverHost: string
  serverPort: number
  apiPrefix: string
}

/** Host names that reach this machine itself, whatever it is listening on. */
const isThisMachine = (hostname: string): boolean => {
  const host = hostname
    .toLowerCase()
    .replace(/^\[|\]$/g, '')
    .replace(/\.$/, '')
  if (host === 'localhost' || host.endsWith('.localhost')) return true
  if (host === '0.0.0.0' || host === '::' || host === '::1') return true
  if (/^127(?:\.\d{1,3}){3}$/.test(host)) return true
  // IPv4-mapped loopback; `URL` writes ::ffff:127.0.0.1 as ::ffff:7f00:1.
  return /^::ffff:(?:127\.|7f[0-9a-f]{2}:)/.test(host)
}

const defaultPort = (protocol: string): number | undefined =>
  protocol === 'http:' ? 80 : protocol === 'https:' ? 443 : undefined

/** The server's address as a client dials it; mirrors `getLocalApiServerUrl`. */
export function localApiServerDisplayUrl(
  server: LocalApiServerAddress
): string {
  const host = server.serverHost === '0.0.0.0' ? '127.0.0.1' : server.serverHost
  const prefix = server.apiPrefix.startsWith('/')
    ? server.apiPrefix
    : `/${server.apiPrefix}`
  return `http://${host}:${server.serverPort}${prefix}`
}

/**
 * `baseUrl` reaches the Local API Server described by `server`.
 *
 * `lanAddresses` are this machine's own network addresses; they reach the
 * server only while it listens on every interface (`0.0.0.0`, LAN access).
 */
export function pointsAtLocalApiServer(
  baseUrl: string,
  server: LocalApiServerAddress,
  lanAddresses: readonly string[] = []
): boolean {
  if (!Number.isInteger(server.serverPort) || server.serverPort <= 0) {
    return false
  }
  let url: URL
  try {
    url = new URL(baseUrl.trim())
  } catch {
    return false
  }
  const port = url.port ? Number(url.port) : defaultPort(url.protocol)
  if (port !== server.serverPort) return false
  if (isThisMachine(url.hostname)) return true
  if (server.serverHost !== '0.0.0.0') return false
  const host = url.hostname.toLowerCase().replace(/^\[|\]$/g, '')
  return lanAddresses.some((address) => address.toLowerCase() === host)
}

/**
 * The Local API Server's own URL when `baseUrl` points at it, as it is
 * configured now; `undefined` otherwise.
 */
export function ownLocalApiServerUrl(
  baseUrl: string,
  lanAddresses: readonly string[] = []
): string | undefined {
  const { serverHost, serverPort, apiPrefix } = useLocalApiServer.getState()
  const server = { serverHost, serverPort, apiPrefix }
  return pointsAtLocalApiServer(baseUrl, server, lanAddresses)
    ? localApiServerDisplayUrl(server)
    : undefined
}
