/**
 * Which navigation-rail section a route belongs to, and the path matching the
 * contextual sidebar uses to highlight its rows.
 */

export type NavigationSection = 'chat' | 'server' | 'models' | 'settings'

const SERVER_PATHS = [
  '/api',
  '/launch',
  '/settings/local-api-server',
  '/settings/remote-lan',
  '/settings/https-proxy',
  '/settings/claude-code',
  '/settings/hermes-agent',
]

const MODELS_PATHS = [
  '/hub',
  '/downloads',
  '/cloud',
  '/endpoints',
  '/settings/providers',
  '/settings/media',
  '/settings/voice',
]

const matchesPath = (pathname: string, path: string) =>
  pathname === path || pathname.startsWith(path + '/')

/** Which rail section owns a route; the contextual sidebar follows it. */
export function navigationSection(pathname: string): NavigationSection {
  if (MODELS_PATHS.some((path) => matchesPath(pathname, path))) return 'models'
  if (SERVER_PATHS.some((path) => matchesPath(pathname, path))) return 'server'
  if (
    matchesPath(pathname, '/settings') ||
    matchesPath(pathname, '/connectors') ||
    matchesPath(pathname, '/skills')
  )
    return 'settings'
  return 'chat'
}

/** `/hub/` and `/hub` are the same place; compare paths without the slash. */
export const normalizePath = (path: string) => path.replace(/\/+$/, '') || '/'

/** True on `to` itself and, when `nested`, on any route below it. */
export function isPathActive(pathname: string, to: string, nested = false) {
  const current = normalizePath(pathname)
  const target = normalizePath(to)
  return current === target || (nested && current.startsWith(target + '/'))
}
