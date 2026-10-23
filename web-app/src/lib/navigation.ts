/**
 * Which navigation-rail section a route belongs to, and the path matching the
 * contextual sidebar uses to highlight its rows.
 */

export type NavigationSection = 'chat' | 'server' | 'models' | 'settings'

/** The icon rail's width, in CSS px. */
export const NAVIGATION_RAIL_WIDTH = 60
/** The title bar row above the rail and the sidebar, in CSS px. */
export const WINDOW_TITLEBAR_HEIGHT = 42
/**
 * The narrowest the page may get beside the docked sidebar, in CSS px
 * (Tailwind's `md`). The sidebar narrows to keep it; once even its minimum
 * width would not, it stops docking and opens over the page instead.
 */
export const MIN_PAGE_WIDTH = 768

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

/**
 * The page the window shows now is `to` or one below it — for code outside
 * the router's React tree (the stores), which reads the location itself.
 */
export function isPageOnScreen(to: string): boolean {
  if (typeof window === 'undefined') return false
  return isPathActive(window.location.pathname, to, true)
}
