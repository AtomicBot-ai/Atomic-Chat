import { act, fireEvent, render, screen } from '@testing-library/react'
import { page } from '@vitest/browser/context'
import { beforeEach, describe, expect, it, vi } from 'vitest'
import type { CSSProperties } from 'react'

import { SidebarInset, SidebarProvider } from '@/components/ui/sidebar'
import { useLeftPanel } from '@/hooks/useLeftPanel'
import { KeyboardShortcutsProvider } from '@/providers/KeyboardShortcuts'
import {
  MIN_PAGE_WIDTH,
  NAVIGATION_RAIL_WIDTH,
  WINDOW_TITLEBAR_HEIGHT,
} from '@/lib/navigation'
import {
  XL_FONT_SIZE,
  setFontSize,
  settle,
  withTranslations,
} from '@/test/layout'
import { LeftSidebar } from '.'

const location = vi.hoisted(() => ({
  pathname: '/settings/general',
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
    <a
      href={to}
      {...props}
      onClick={(event) => {
        // A real Link navigates in place; the test page must stay put.
        event.preventDefault()
        ;(props as { onClick?: (e: unknown) => void }).onClick?.(event)
      }}
    >
      {children}
    </a>
  ),
  useLocation: () => location,
  useNavigate: () => vi.fn(),
  useParams: () => ({}),
  useRouter: () => ({ navigate: vi.fn(), state: { location } }),
}))

vi.mock('@/hooks/useServiceHub', () => ({
  useServiceHub: () => ({ opener: () => ({ open: vi.fn() }) }),
  getServiceHub: () => ({
    projects: () => ({ getProjects: async () => [] }),
  }),
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

vi.mock('@/containers/dialogs/AddProjectDialog', () => ({
  default: () => null,
}))
vi.mock('@/containers/dialogs/SearchDialog', () => ({
  SearchDialog: () => null,
}))

const RAIL = NAVIGATION_RAIL_WIDTH
const DEFAULT_WIDTH = 240
const MIN_WIDTH = 224

/** The navigation shell exactly as `__root.tsx` wires it to the saved state. */
function Shell() {
  const open = useLeftPanel((state) => state.open)
  const setOpen = useLeftPanel((state) => state.setLeftPanel)
  const width = useLeftPanel((state) => state.width)
  const setWidth = useLeftPanel((state) => state.setLeftPanelWidth)
  return withTranslations(
    <SidebarProvider
      className="app-shell"
      style={
        {
          '--navigation-rail-width': `${RAIL}px`,
          '--window-titlebar-height': `${WINDOW_TITLEBAR_HEIGHT}px`,
        } as CSSProperties
      }
      open={open}
      onOpenChange={setOpen}
      defaultWidth={width}
      onWidthChange={setWidth}
      insetOffset={RAIL}
      minInsetWidth={MIN_PAGE_WIDTH}
    >
      <KeyboardShortcutsProvider />
      <LeftSidebar />
      <SidebarInset>
        <div className="relative h-svh" data-testid="page">
          {/* A page's own raised layer, like the composer's "/" skill menu. */}
          <div
            data-testid="page-menu"
            className="absolute bottom-24 left-3 z-50 h-24 w-64 bg-popover"
          />
        </div>
      </SidebarInset>
    </SidebarProvider>
  )
}

const panelBox = () =>
  (
    document.querySelector('[data-sidebar="sidebar"]') as HTMLElement
  ).parentElement!.getBoundingClientRect()
const pageBox = () => screen.getByTestId('page').getBoundingClientRect()
const toggle = () => screen.getByRole('button', { name: 'Toggle sidebar' })

/** The panel is on screen beside the rail (not slid away under it). */
function expectPanelShown(width = DEFAULT_WIDTH) {
  const box = panelBox()
  expect(box.left).toBe(RAIL)
  expect(Math.round(box.width)).toBe(width)
}
function expectPanelHidden() {
  expect(Math.round(panelBox().right)).toBeLessThanOrEqual(RAIL)
}
/** The page runs from the rail to the window's right edge. */
function expectPageFillsWindow(windowWidth: number) {
  const box = pageBox()
  expect(Math.round(box.left)).toBe(RAIL)
  expect(Math.round(box.width)).toBe(windowWidth - RAIL)
}
function expectNoPageScroll(windowWidth: number) {
  expect(document.documentElement.scrollWidth).toBeLessThanOrEqual(windowWidth)
  const shell = document.querySelector('.app-shell') as HTMLElement
  expect(shell.scrollWidth).toBeLessThanOrEqual(shell.clientWidth)
}

async function resizeWindow(width: number) {
  await page.viewport(width, 800)
  // The first pass lets the media query re-render the shell; the second waits
  // for the slide that re-render starts.
  await settle()
  await settle()
}

beforeEach(() => {
  location.pathname = '/settings/general'
  useLeftPanel.setState({ open: true, width: '15rem' })
})

describe('the sidebar at a narrow window', () => {
  it.each(['16px', XL_FONT_SIZE])(
    'folds away at 1024 px so the page gets the window (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      await page.viewport(1024, 800)
      render(<Shell />)
      await settle()

      expectPanelHidden()
      expectPageFillsWindow(1024)
      expectNoPageScroll(1024)
      // Folding for the window is not the user's choice: it is not saved.
      expect(useLeftPanel.getState().open).toBe(true)
    }
  )

  it.each(['16px', XL_FONT_SIZE])(
    'opens over the page from the toggle and closes on Escape (%s)',
    async (fontSize) => {
      setFontSize(fontSize)
      await page.viewport(1024, 800)
      useLeftPanel.setState({ open: false })
      render(<Shell />)
      await settle()

      fireEvent.click(toggle())
      await settle()
      expectPanelShown()
      // Over the page, not beside it: the page does not move or shrink.
      expectPageFillsWindow(1024)
      expectNoPageScroll(1024)
      expect(useLeftPanel.getState().open).toBe(false)

      fireEvent.keyDown(document.body, { key: 'Escape' })
      await settle()
      expectPanelHidden()
      expect(useLeftPanel.getState().open).toBe(false)
    }
  )

  it('opens and closes the overlay with the sidebar shortcut', async () => {
    await page.viewport(1024, 800)
    render(<Shell />)
    await settle()

    // Cmd+B on macOS, Ctrl+B elsewhere, as Settings → Shortcuts lists it.
    const mac = navigator.userAgent.toUpperCase().includes('MAC')
    const shortcut = { key: 'b', metaKey: mac, ctrlKey: !mac }
    fireEvent.keyDown(window, shortcut)
    await settle()
    expectPanelShown()
    expectPageFillsWindow(1024)

    fireEvent.keyDown(window, shortcut)
    await settle()
    expectPanelHidden()
    expect(useLeftPanel.getState().open).toBe(true)

    // Docked, the shortcut is the saved preference again.
    await resizeWindow(1280)
    expectPanelShown()
    fireEvent.keyDown(window, shortcut)
    await settle()
    expectPanelHidden()
    expect(useLeftPanel.getState().open).toBe(false)
  })

  it('shows a section picked in the rail over the page', async () => {
    await page.viewport(1024, 800)
    render(<Shell />)
    await settle()

    fireEvent.click(screen.getByTestId('rail-server'))
    await settle()
    expectPanelShown()
    expectPageFillsWindow(1024)
    // A press on the rail is the rail's: the overlay stays for the section.
    fireEvent.pointerDown(screen.getByTestId('rail-models'), {
      clientX: RAIL / 2,
      clientY: 200,
    })
    await settle()
    expectPanelShown()
  })

  it('closes the overlay after a row is picked or the page is clicked', async () => {
    await page.viewport(1024, 800)
    render(<Shell />)
    await settle()

    fireEvent.click(toggle())
    await settle()
    expectPanelShown()
    fireEvent.click(screen.getByRole('link', { name: 'Hardware' }))
    await settle()
    expectPanelHidden()

    fireEvent.click(toggle())
    await settle()
    expectPanelShown()
    const pageRect = pageBox()
    fireEvent.pointerDown(screen.getByTestId('page'), {
      clientX: pageRect.left + pageRect.width / 2,
      clientY: pageRect.top + 100,
    })
    await settle()
    expectPanelHidden()
    expect(useLeftPanel.getState().open).toBe(true)
  })

  it('starts the overlay closed again after a docked spell', async () => {
    await resizeWindow(1024)
    render(<Shell />)
    await settle()
    fireEvent.click(toggle())
    await settle()
    expectPanelShown()

    await resizeWindow(1280)
    expectPanelShown()
    expect(Math.round(pageBox().left)).toBe(RAIL + DEFAULT_WIDTH)

    await resizeWindow(1024)
    expectPanelHidden()
    expectPageFillsWindow(1024)
  })

  it('lies over the page’s own raised layers', async () => {
    await page.viewport(1024, 800)
    render(<Shell />)
    await settle()
    fireEvent.click(toggle())
    await settle()

    const menu = screen.getByTestId('page-menu').getBoundingClientRect()
    const panel = panelBox()
    // A point the page's z-50 menu and the open panel share.
    const x = (menu.left + panel.right) / 2
    expect(x).toBeLessThan(panel.right)
    const hit = document.elementFromPoint(x, menu.top + menu.height / 2)
    expect(
      hit?.closest('[data-sidebar="sidebar"]'),
      hit?.outerHTML.slice(0, 80)
    ).not.toBeNull()
  })

  it('hands focus to the toggle when it folds, and keeps folded rows out of reach', async () => {
    await page.viewport(1024, 800)
    render(<Shell />)
    await settle()

    fireEvent.click(toggle())
    await settle()
    const row = screen.getByRole('link', { name: 'Hardware' })
    await act(async () => row.focus())
    expect(document.activeElement).toBe(row)
    // Enter on a link is a click: the page opens, the overlay folds.
    fireEvent.click(row)
    await settle()
    expectPanelHidden()
    expect(document.activeElement).toBe(toggle())
    expect(row.closest('[inert]')).not.toBeNull()

    // Docked, folding with the shortcut does the same.
    await resizeWindow(1280)
    expectPanelShown()
    expect(row.closest('[inert]')).toBeNull()
    await act(async () => row.focus())
    const mac = navigator.userAgent.toUpperCase().includes('MAC')
    fireEvent.keyDown(window, { key: 'b', metaKey: mac, ctrlKey: !mac })
    await settle()
    expectPanelHidden()
    expect(document.activeElement).toBe(toggle())
    expect(row.closest('[inert]')).not.toBeNull()
  })

  it('docks again once the window is wide enough, as the user left it', async () => {
    await resizeWindow(1280)
    render(<Shell />)
    await settle()
    expectPanelShown()
    expect(Math.round(pageBox().left)).toBe(Math.round(panelBox().right))

    await resizeWindow(1024)
    expectPanelHidden()
    expectPageFillsWindow(1024)

    await resizeWindow(1280)
    expectPanelShown()
    expect(Math.round(pageBox().left)).toBe(RAIL + DEFAULT_WIDTH)
    expect(useLeftPanel.getState().open).toBe(true)
  })

  it('narrows a wide saved sidebar before it would squeeze the page', async () => {
    useLeftPanel.setState({ width: '30rem' })
    await resizeWindow(1100)
    render(<Shell />)
    await settle()

    expectPanelShown(1100 - RAIL - MIN_PAGE_WIDTH)
    expect(Math.round(pageBox().width)).toBe(MIN_PAGE_WIDTH)
    expectNoPageScroll(1100)
    // The saved width is kept for a wider window.
    expect(useLeftPanel.getState().width).toBe('30rem')

    await resizeWindow(1440)
    expectPanelShown(480)
  })
})

describe('the sidebar resize handle', () => {
  it('sits on the panel edge and resizes from the keyboard within bounds', async () => {
    await resizeWindow(1280)
    render(<Shell />)
    await settle()

    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    const handleBox = handle.getBoundingClientRect()
    expect(
      Math.abs(handleBox.left + handleBox.width / 2 - panelBox().right)
    ).toBeLessThanOrEqual(1)
    expect(handle).toHaveAttribute('aria-orientation', 'vertical')
    expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH))
    expect(handle).toHaveAttribute('aria-valuemin', String(MIN_WIDTH))
    const max = 1280 - RAIL - MIN_PAGE_WIDTH
    expect(handle).toHaveAttribute('aria-valuemax', String(max))

    handle.focus()
    fireEvent.keyDown(handle, { key: 'ArrowRight' })
    await settle()
    expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH + 16))
    expect(Math.round(pageBox().left)).toBe(RAIL + DEFAULT_WIDTH + 16)

    fireEvent.keyDown(handle, { key: 'End' })
    await settle()
    expect(handle).toHaveAttribute('aria-valuenow', String(max))
    expect(Math.round(pageBox().width)).toBe(MIN_PAGE_WIDTH)
    expectNoPageScroll(1280)

    fireEvent.keyDown(handle, { key: 'Home' })
    await settle()
    expect(handle).toHaveAttribute('aria-valuenow', String(MIN_WIDTH))
    expectPanelShown(MIN_WIDTH)

    // Double-click puts the default width back, and it is saved.
    fireEvent.doubleClick(handle)
    await settle()
    expect(handle).toHaveAttribute('aria-valuenow', String(DEFAULT_WIDTH))
    expectPanelShown()
    expect(useLeftPanel.getState().width).toBe('15rem')
  })

  it('leaves the panel open when the handle is clicked', async () => {
    await resizeWindow(1280)
    render(<Shell />)
    await settle()

    const handle = screen.getByRole('separator', { name: 'Resize sidebar' })
    await act(async () => {
      fireEvent.mouseDown(handle, { clientX: 300 })
      fireEvent.mouseUp(document, { clientX: 300 })
    })
    await settle()
    expectPanelShown()
    expect(useLeftPanel.getState().open).toBe(true)
  })
})
