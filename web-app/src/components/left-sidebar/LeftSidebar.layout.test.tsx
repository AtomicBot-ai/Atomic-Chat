import { render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CSSProperties } from 'react'

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useLocalApiServer } from '@/hooks/useLocalApiServer'
import {
  XL_FONT_SIZE,
  expectNoHorizontalOverflow,
  expectOneLine,
  setFontSize,
  setTheme,
  settle,
  withTranslations,
} from '@/test/layout'
import { LeftSidebar } from '.'

const location = vi.hoisted(() => ({
  pathname: '/',
  search: {} as Record<string, unknown>,
}))

vi.mock('@tanstack/react-router', () => ({
  Link: ({
    children,
    to,
    params: _params,
    search: _search,
    hash: _hash,
    ...props
  }: {
    children: React.ReactNode
    to: string
    params?: unknown
    search?: unknown
    hash?: string
  }) => (
    <a href={to} {...props}>
      {children}
    </a>
  ),
  useLocation: () => location,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open: vi.fn() }) }),
  getServiceHub: () => ({}),
}))

vi.mock('@/hooks/useLocalApiServerControl', () => ({
  useLocalApiServerControl: () => ({
    status: 'stopped',
    isRunning: false,
    isBusy: false,
    start: vi.fn(),
    stop: vi.fn(),
    toggle: vi.fn(),
  }),
}))

vi.mock('@/lib/integration-agent-detection', () => ({
  detectIntegrationAgentsOnce: () => {},
}))

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({ default: () => null }))
vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => null,
}))

// The Server panel and every gated row show, as in the desktop build.
vi.mock('@/lib/platform/const', async (importOriginal) => {
  const actual = await importOriginal<typeof import('@/lib/platform/const')>()
  return {
    PlatformFeatures: new Proxy(actual.PlatformFeatures, {
      get: () => true,
    }),
  }
})

const TITLEBAR = 42
const RAIL = 60

function Shell() {
  return withTranslations(
    <SidebarProvider
      className="app-shell"
      style={
        {
          '--navigation-rail-width': `${RAIL}px`,
          '--window-titlebar-height': `${TITLEBAR}px`,
        } as CSSProperties
      }
    >
      <LeftSidebar />
      <SidebarInset>
        <div className="h-svh" data-testid="page" />
      </SidebarInset>
    </SidebarProvider>
  )
}

const SECTIONS = [
  { name: 'Workspace', pathname: '/' },
  { name: 'Server', pathname: '/api/' },
  { name: 'Models Hub', pathname: '/hub/' },
  { name: 'Settings', pathname: '/settings/general' },
]

beforeEach(() => {
  location.search = {}
  // The worst-case model id the Server panel has to fit.
  useLocalApiServer.setState({
    defaultModelLocalApiServer: {
      model: 'unsloth/' + 'VeryLongModelName'.repeat(6) + '-Q4_K_M',
      provider: 'llamacpp-upstream',
    },
  })
})

describe.each(['light', 'dark'] as const)('navigation shell in %s theme', (theme) => {
  it.each(
    SECTIONS.flatMap((section) =>
      [1024, 1280].flatMap((width) =>
        ['16px', XL_FONT_SIZE].map((fontSize) => ({
          ...section,
          width,
          fontSize,
        }))
      )
    )
  )(
    '$name fits at $width px / $fontSize',
    async ({ pathname, width, fontSize }) => {
      await page.viewport(width, 800)
      setTheme(theme)
      setFontSize(fontSize)
      location.pathname = pathname
      render(<Shell />)
      await settle()

      // The title bar spans the window above both navigation layers.
      const titlebar = screen
        .getByRole('button', { name: 'Toggle sidebar' })
        .closest('.fixed') as HTMLElement
      expect(titlebar.getBoundingClientRect()).toMatchObject({
        top: 0,
        left: 0,
        height: TITLEBAR,
        width,
      })

      // The rail sits under it, at the window's left edge.
      const rail = screen.getByRole('navigation', {
        name: 'Primary navigation',
      })
      const railBox = rail.getBoundingClientRect()
      expect(railBox.top).toBe(TITLEBAR)
      expect(railBox.width).toBe(RAIL)
      expect(railBox.bottom).toBe(800)

      // The floating panel starts after the rail, under the title bar.
      const panel = document.querySelector(
        '[data-sidebar="sidebar"]'
      ) as HTMLElement
      const container = panel.parentElement!.getBoundingClientRect()
      expect(container.left).toBe(RAIL)
      expect(container.top).toBe(TITLEBAR)
      expect(Math.round(container.bottom)).toBe(800)

      // The page fills the rest, its h-svh mapped below the title bar.
      const pageBox = screen.getByTestId('page').getBoundingClientRect()
      expect(pageBox.top).toBe(TITLEBAR)
      expect(Math.round(pageBox.left)).toBe(Math.round(container.right))
      expect(pageBox.bottom).toBe(800)

      // dnd-kit's screen-reader live region is a 1 px box pulled to -1 px by
      // design; it is never painted, so it is not part of the layout.
      for (const live of panel.querySelectorAll<HTMLElement>(
        '[role="status"][aria-live]'
      )) {
        live.style.display = 'none'
      }
      // The resize handle straddles the panel's edge on purpose, so the
      // panel's own regions are what must not spill.
      for (const region of panel.querySelectorAll<HTMLElement>(
        '[data-sidebar="header"], [data-sidebar="content"]'
      )) {
        expectNoHorizontalOverflow(region)
      }
      // Each row's label stays on one line; long ones truncate.
      const labels = panel.querySelectorAll<HTMLElement>(
        '[data-sidebar="menu-button"] span.truncate'
      )
      expect(labels.length).toBeGreaterThan(0)
      for (const label of labels) {
        expectOneLine(label)
      }
    }
  )
})
